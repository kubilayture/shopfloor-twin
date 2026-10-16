/**
 * The OEE part of the ground truth (#117, ADR-0021): per machine the `oee-core` inputs of every
 * shift bucket and every UTC hour, and per machine and work center the `bucketOee` /
 * `workCenterOee` result of every shift bucket. The inputs are kept incrementally while events are
 * recorded; results are computed only when a summary or snapshot is read.
 */
import {
  CYCLE_RESULTS,
  bucketOee,
  formatFraction,
  toDecimal,
  workCenterOee,
  type BucketInput,
  type CycleCount,
  type CycleResult,
  type Fraction,
  type OeeConfig,
  type OeeResult,
  type StopPiece,
} from '@shopfloor/oee-core';
import { idealCycleMs, type PlantConfig } from '@shopfloor/plant-config';
import { NO_SHIFT, hourStart, shiftKeyAt } from '@shopfloor/shift-calendar';
import type { SimTime } from '@shopfloor/sim-core';
import { isoTime } from './serialize.ts';
import { MACHINE_STATES, type MachineState } from '../plant/machine-state.ts';

export type StateMs = Record<MachineState, number>;

export const zeroStates = (): StateMs =>
  Object.fromEntries(MACHINE_STATES.map((s) => [s, 0])) as StateMs;

const HOUR = 3_600_000;

/** A ratio as an exact reduced fraction and rounded half-up to four decimals. */
export interface RatioJson {
  readonly fraction: string;
  readonly decimal: string;
}

export interface OeeTotalsJson {
  readonly plannedBusyMs: number;
  readonly actualProductionMs: number;
  readonly excludedMs: number;
  readonly longStopMs: number;
  readonly microStopMs: number;
  readonly idealMs: number;
  readonly good: number;
  readonly scrap: number;
  readonly rework: number;
  readonly produced: number;
}

export interface OeeLossesJson {
  readonly availability: {
    readonly own: {
      readonly stopped: number;
      readonly down: number;
      readonly setup: number;
      readonly idle: number;
      readonly total: number;
    };
    readonly external: {
      readonly starved: number;
      readonly blocked: number;
      readonly total: number;
    };
  };
  readonly performance: {
    readonly microStops: number;
    readonly speed: number;
    readonly total: number;
  };
  /** Ideal ms × (1 − Q), exact. */
  readonly quality: RatioJson;
}

/** `bucketOee` / `workCenterOee` as JSON: fractions as `num/den` and four-decimal strings. */
export interface OeeResultJson {
  readonly availability: RatioJson | null;
  readonly performance: RatioJson | null;
  readonly quality: RatioJson | null;
  readonly oee: RatioJson | null;
  readonly anomaly: boolean;
  readonly provisional: boolean;
  readonly totals: OeeTotalsJson;
  readonly unplanned: {
    readonly good: number;
    readonly produced: number;
    readonly idealMs: number;
  };
  readonly losses: OeeLossesJson | null;
}

/** The `oee-core` inputs of one bucket of one machine (its operation and ideal times sit beside). */
export interface BucketInputsJson {
  readonly scheduled: boolean;
  readonly stateMs: StateMs;
  readonly stops: readonly StopPiece[];
  readonly cycles: readonly CycleCount[];
}

export interface HourInputsJson extends BucketInputsJson {
  /** The shift bucket the hour lies in (shifts start and end on whole hours). */
  readonly shift: string;
}

export interface MachineOeeJson {
  readonly operation: string;
  /** Ideal cycle time at this machine's operation, per product, integer ms. */
  readonly idealCycleMs: Record<string, number>;
  readonly shifts: Record<
    string,
    { readonly inputs: BucketInputsJson; readonly result: OeeResultJson }
  >;
  /** Keyed by the hour's start, ISO 8601 UTC; inputs only (`bucketOee` of them gives the result). */
  readonly hours: Record<string, HourInputsJson>;
}

export interface WorkCenterOeeJson {
  readonly equipment: readonly string[];
  /** `workCenterOee` of the member machines' inputs in the same shift bucket. */
  readonly shifts: Record<string, OeeResultJson>;
}

export interface OeeSummary {
  readonly config: OeeConfig;
  readonly machines: Record<string, MachineOeeJson>;
  readonly workCenters: Record<string, WorkCenterOeeJson>;
}

interface Bucket {
  readonly stops: StopPiece[];
  /** `product␀result` → count. */
  readonly cycles: Map<string, number>;
}

interface HourBucket extends Bucket {
  readonly stateMs: StateMs;
}

interface MachineOee {
  readonly operation: string;
  readonly hours: Map<SimTime, HourBucket>;
  readonly shifts: Map<string, Bucket>;
  /** Start of the Stopped interval the machine is in, if any. */
  stopStart: SimTime | undefined;
}

const newBucket = (): Bucket => ({ stops: [], cycles: new Map() });

function safe(value: bigint, what: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    throw new RangeError(`${what} ${String(value)} is not a safe integer`);
  }
  return result;
}

const ratio = (f: Fraction | null): RatioJson | null =>
  f === null ? null : { fraction: formatFraction(f), decimal: toDecimal(f) };

export function resultJson(result: OeeResult): OeeResultJson {
  const t = result.totals;
  const n = (value: bigint, what: string) => safe(value, what);
  const losses = result.losses;
  return {
    availability: ratio(result.availability),
    performance: ratio(result.performance),
    quality: ratio(result.quality),
    oee: ratio(result.oee),
    anomaly: result.anomaly,
    provisional: result.provisional,
    totals: {
      plannedBusyMs: n(t.plannedBusyMs, 'PBT'),
      actualProductionMs: n(t.actualProductionMs, 'APT'),
      excludedMs: n(t.excludedMs, 'excluded'),
      longStopMs: n(t.longStopMs, 'long stops'),
      microStopMs: n(t.microStopMs, 'micro-stops'),
      idealMs: n(t.idealMs, 'ideal'),
      good: n(t.good, 'good'),
      scrap: n(t.scrap, 'scrap'),
      rework: n(t.rework, 'rework'),
      produced: n(t.produced, 'produced'),
    },
    unplanned: {
      good: n(t.unplanned.good, 'unplanned good'),
      produced: n(t.unplanned.produced, 'unplanned produced'),
      idealMs: n(t.unplanned.idealMs, 'unplanned ideal'),
    },
    losses:
      losses === null
        ? null
        : {
            availability: {
              own: {
                stopped: n(losses.availability.own.stopped, 'stopped loss'),
                down: n(losses.availability.own.down, 'down loss'),
                setup: n(losses.availability.own.setup, 'setup loss'),
                idle: n(losses.availability.own.idle, 'idle loss'),
                total: n(losses.availability.own.total, 'own loss'),
              },
              external: {
                starved: n(losses.availability.external.starved, 'starved loss'),
                blocked: n(losses.availability.external.blocked, 'blocked loss'),
                total: n(losses.availability.external.total, 'external loss'),
              },
            },
            performance: {
              microStops: n(losses.performance.microStops, 'micro-stop loss'),
              speed: n(losses.performance.speed, 'speed loss'),
              total: n(losses.performance.total, 'performance loss'),
            },
            quality: ratio(losses.quality) ?? { fraction: '0/1', decimal: '0.0000' },
          },
  };
}

const RESULT_ORDER: Record<CycleResult, number> = Object.fromEntries(
  CYCLE_RESULTS.map((result, i) => [result, i]),
) as Record<CycleResult, number>;

/** Copies of the closed pieces, plus the open one: a caller can't reach the recorded state. */
const withOpen = (closed: readonly StopPiece[] | undefined, open: StopPiece | undefined) => {
  const pieces = (closed ?? []).map((piece) => ({ ...piece }));
  return open ? [...pieces, open] : pieces;
};

function cycleCounts(cycles: ReadonlyMap<string, number>): CycleCount[] {
  return [...cycles]
    .map(([key, count]) => {
      const [product = '', result = 'good'] = key.split('\u0000');
      return { product, result: result as CycleResult, count };
    })
    .sort((a, b) =>
      a.product < b.product
        ? -1
        : a.product > b.product
          ? 1
          : RESULT_ORDER[a.result] - RESULT_ORDER[b.result],
    );
}

/** Pieces of [from, to) cut at UTC hours. */
function hourPieces(from: SimTime, to: SimTime): { hour: SimTime; ms: number }[] {
  const pieces: { hour: SimTime; ms: number }[] = [];
  let at = from;
  while (at < to) {
    const hour = hourStart(at);
    const end = Math.min(hour + HOUR, to);
    pieces.push({ hour, ms: end - at });
    at = end;
  }
  return pieces;
}

/**
 * Keeps the OEE inputs of every machine while `GroundTruth` records events. Time per state per
 * hour comes from `addTime`; the shift buckets' time per state is `GroundTruth`'s own `byShift`,
 * accounted independently from the shift events, so Σ hours = shift is a real check.
 */
export class OeeTruth {
  readonly #config: OeeConfig;
  readonly #shifts: PlantConfig['shifts'];
  readonly #ideal: Record<string, Record<string, number>>;
  readonly #machines = new Map<string, MachineOee>();
  readonly #workCenters: { id: string; equipment: string[] }[];
  readonly #hourKeys = new Map<SimTime, string>();

  constructor(config: PlantConfig) {
    this.#config = config.oee;
    this.#shifts = config.shifts;
    this.#ideal = idealCycleMs(config);
    this.#workCenters = config.plant.areas.flatMap((area) =>
      area.workCenters.map((wc) => ({ id: wc.id, equipment: wc.equipment.map((e) => e.id) })),
    );
    for (const equipment of config.plant.areas.flatMap((a) =>
      a.workCenters.flatMap((w) => w.equipment),
    )) {
      this.#machines.set(equipment.id, {
        operation: equipment.operation,
        hours: new Map(),
        shifts: new Map(),
        stopStart: undefined,
      });
    }
  }

  /**
   * The shift bucket of a UTC hour: `shiftKeyAt` of its start, cached. Plant-config requires whole-
   * hour shifts, so every instant of the hour has this key: a cycle is bucketed by its time, as
   * the MES buckets it, not by the shift event the run has seen.
   */
  shiftKeyOfHour(hour: SimTime): string {
    let key = this.#hourKeys.get(hour);
    if (key === undefined) {
      key = shiftKeyAt(this.#shifts, hour);
      this.#hourKeys.set(hour, key);
    }
    return key;
  }

  /** Time in `state` over [from, to), credited to its UTC hours. */
  addTime(machineId: string, state: MachineState, from: SimTime, to: SimTime): void {
    const machine = this.#machine(machineId);
    for (const piece of hourPieces(from, to)) {
      this.#hour(machine, piece.hour).stateMs[state] += piece.ms;
    }
  }

  /** A state change at `at` (time up to `at` already added). Holds Stopped intervals until they close. */
  stateChange(machineId: string, from: MachineState, to: MachineState, at: SimTime): void {
    const machine = this.#machine(machineId);
    if (from !== 'Stopped' && to === 'Stopped') {
      machine.stopStart = at;
    } else if (from === 'Stopped' && to !== 'Stopped' && machine.stopStart !== undefined) {
      const cut = this.#cutStop(machine.stopStart, at, false);
      for (const [hour, piece] of cut.hours) {
        this.#hour(machine, hour).stops.push(piece);
      }
      for (const [key, piece] of cut.shifts) {
        this.#shift(machine, key).stops.push(piece);
      }
      machine.stopStart = undefined;
    }
  }

  cycle(machineId: string, product: string, result: CycleResult, at: SimTime): void {
    const machine = this.#machine(machineId);
    const hour = hourStart(at);
    const key = `${product}\u0000${result}`;
    for (const bucket of [
      this.#hour(machine, hour),
      this.#shift(machine, this.shiftKeyOfHour(hour)),
    ]) {
      bucket.cycles.set(key, (bucket.cycles.get(key) ?? 0) + 1);
    }
  }

  /**
   * The OEE section at `now`, without changing anything. `open` gives each machine's current state
   * and where its uncounted time starts; `byShift` is the time per state per shift bucket up to
   * `now`. An open Stopped interval's `wholeMs` runs to `now` (ADR-0021).
   */
  summary(
    now: SimTime,
    open: ReadonlyMap<string, { state: MachineState; since: SimTime }>,
    byShift: ReadonlyMap<string, Readonly<Record<string, StateMs>>>,
  ): OeeSummary {
    const inputsByShift = new Map<string, Map<string, BucketInput>>();
    const machines: Record<string, MachineOeeJson> = {};
    for (const [id, machine] of this.#machines) {
      const current = open.get(id);
      let hourStops = new Map<SimTime, StopPiece>();
      let shiftStops = new Map<string, StopPiece>();
      const openHours = new Map<SimTime, number>();
      if (current && now > current.since) {
        for (const piece of hourPieces(current.since, now)) {
          openHours.set(piece.hour, piece.ms);
        }
      }
      if (current?.state === 'Stopped' && machine.stopStart !== undefined) {
        const cut = this.#cutStop(machine.stopStart, now, true);
        hourStops = new Map(cut.hours);
        shiftStops = new Map(cut.shifts);
      }
      const hourKeys = [...new Set([...machine.hours.keys(), ...openHours.keys()])].sort(
        (a, b) => a - b,
      );
      const hours: Record<string, HourInputsJson> = {};
      for (const hour of hourKeys) {
        const bucket = machine.hours.get(hour);
        const stateMs = bucket ? { ...bucket.stateMs } : zeroStates();
        const extra = openHours.get(hour);
        if (extra !== undefined && current) {
          stateMs[current.state] += extra;
        }
        const shift = this.shiftKeyOfHour(hour);
        hours[isoTime(hour)] = {
          shift,
          scheduled: shift !== NO_SHIFT,
          stateMs,
          stops: withOpen(bucket?.stops, hourStops.get(hour)),
          cycles: cycleCounts(bucket?.cycles ?? new Map()),
        };
      }

      const ideal = Object.fromEntries(
        Object.entries(this.#ideal)
          .filter(([, ops]) => ops[machine.operation] !== undefined)
          .map(([product, ops]) => [product, ops[machine.operation] ?? 0]),
      );
      const shifts: MachineOeeJson['shifts'] = {};
      const states = byShift.get(id) ?? {};
      const keys = [...new Set([...Object.keys(states), ...machine.shifts.keys()])].sort();
      for (const key of keys) {
        const bucket = machine.shifts.get(key);
        const inputs: BucketInputsJson = {
          scheduled: key !== NO_SHIFT,
          stateMs: { ...(states[key] ?? zeroStates()) },
          stops: withOpen(bucket?.stops, shiftStops.get(key)),
          cycles: cycleCounts(bucket?.cycles ?? new Map()),
        };
        const input: BucketInput = {
          ...inputs,
          operation: machine.operation,
          idealCycleMs: this.#ideal,
        };
        const perMachine = inputsByShift.get(key) ?? new Map<string, BucketInput>();
        perMachine.set(id, input);
        inputsByShift.set(key, perMachine);
        shifts[key] = { inputs, result: resultJson(bucketOee(input, this.#config)) };
      }
      machines[id] = { operation: machine.operation, idealCycleMs: ideal, shifts, hours };
    }

    const workCenters: Record<string, WorkCenterOeeJson> = {};
    for (const wc of this.#workCenters) {
      const shifts: Record<string, OeeResultJson> = {};
      for (const key of [...inputsByShift.keys()].sort()) {
        const inputs = wc.equipment.flatMap((id) => {
          const input = inputsByShift.get(key)?.get(id);
          return input ? [input] : [];
        });
        if (inputs.length > 0) {
          shifts[key] = resultJson(workCenterOee(inputs, this.#config));
        }
      }
      workCenters[wc.id] = { equipment: wc.equipment, shifts };
    }
    return {
      config: {
        microStopThresholdMs: this.#config.microStopThresholdMs,
        scheduledTime: this.#config.scheduledTime,
      },
      machines,
      workCenters,
    };
  }

  /**
   * The Stopped interval [start, end) cut into one piece per UTC hour and one per shift bucket, each
   * carrying the whole length (ADR-0021: the threshold applies to the whole interval).
   */
  #cutStop(
    start: SimTime,
    end: SimTime,
    open: boolean,
  ): { hours: [SimTime, StopPiece][]; shifts: [string, StopPiece][] } {
    const wholeMs = end - start;
    const piece = (ms: number): StopPiece => (open ? { ms, wholeMs, open } : { ms, wholeMs });
    const pieces = hourPieces(start, end);
    const perShift = new Map<string, number>();
    for (const p of pieces) {
      const key = this.shiftKeyOfHour(p.hour);
      perShift.set(key, (perShift.get(key) ?? 0) + p.ms);
    }
    return {
      hours: pieces.map((p) => [p.hour, piece(p.ms)]),
      shifts: [...perShift].map(([key, ms]) => [key, piece(ms)]),
    };
  }

  #machine(id: string): MachineOee {
    const machine = this.#machines.get(id);
    if (!machine) {
      throw new RangeError(`unknown machine "${id}"`);
    }
    return machine;
  }

  #hour(machine: MachineOee, hour: SimTime): HourBucket {
    let bucket = machine.hours.get(hour);
    if (!bucket) {
      bucket = { stateMs: zeroStates(), stops: [], cycles: new Map() };
      machine.hours.set(hour, bucket);
    }
    return bucket;
  }

  #shift(machine: MachineOee, key: string): Bucket {
    let bucket = machine.shifts.get(key);
    if (!bucket) {
      bucket = newBucket();
      machine.shifts.set(key, bucket);
    }
    return bucket;
  }
}
