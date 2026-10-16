/**
 * OEE per ISO 22400-2 as defined in ADR-0021 and plan section 7: availability, performance,
 * quality and their losses for one bucket (an hour or a shift) of one machine, or for a work
 * center as the sum of its machines' inputs. Integer inputs, exact BigInt fractions out.
 */
import { fraction, type Fraction } from './fraction.ts';
import type { Millis } from './intervals.ts';

/** The machine states of the UNS contract (`@shopfloor/contracts`), repeated: oee-core is pure. */
export const OEE_STATES = [
  'Off',
  'Idle',
  'Running',
  'Stopped',
  'Starved',
  'Blocked',
  'Setup',
  'Down',
  'PlannedStop',
  'Maintenance',
] as const;

export type OeeState = (typeof OEE_STATES)[number];

/** Excluded from planned busy time: breaks, planned maintenance and the machine switched off. */
export const EXCLUDED_STATES: readonly OeeState[] = ['PlannedStop', 'Maintenance', 'Off'];

/** Availability loss inside planned busy time (ADR-0021): the machine's own, or external. */
export type AvailabilityLoss = 'own' | 'external';

/** Own availability loss; Stopped only when the whole interval reaches the micro-stop threshold. */
export const OWN_LOSS_STATES: readonly OeeState[] = ['Stopped', 'Down', 'Setup', 'Idle'];

/** External availability loss: not the machine's fault. */
export const EXTERNAL_LOSS_STATES: readonly OeeState[] = ['Starved', 'Blocked'];

/**
 * The availability loss an interval counts as inside planned busy time (ADR-0021's loss table), or
 * undefined: Running, a micro-stop (Stopped below the threshold, measured over the whole interval,
 * so far if it is open) and the excluded states are no availability loss.
 */
export function availabilityLoss(
  state: string,
  wholeMs: Millis,
  microStopThresholdMs: Millis,
): AvailabilityLoss | undefined {
  if (EXTERNAL_LOSS_STATES.some((s) => s === state)) return 'external';
  if (!OWN_LOSS_STATES.some((s) => s === state)) return undefined;
  return state !== 'Stopped' || wholeMs >= microStopThresholdMs ? 'own' : undefined;
}

export const CYCLE_RESULTS = ['good', 'scrap', 'rework'] as const;

export type CycleResult = (typeof CYCLE_RESULTS)[number];

/** `config/plant/oee.yaml`. */
export interface OeeConfig {
  readonly microStopThresholdMs: Millis;
  /** Phases 1–6: every shift bucket is scheduled and the no-shift bucket never is. */
  readonly scheduledTime: 'shift-calendar';
}

/** The part of one Stopped interval that lies in the bucket. */
export interface StopPiece {
  /** Milliseconds of the interval inside this bucket. */
  readonly ms: Millis;
  /** The length of the whole interval (so far, if open): the threshold applies to this. */
  readonly wholeMs: Millis;
  /** Still open: if it is below the threshold now, its micro-stop classification is provisional. */
  readonly open?: boolean;
}

export interface CycleCount {
  readonly product: string;
  readonly result: CycleResult;
  readonly count: number;
}

/** OEE inputs of one machine for one bucket (one device epoch). */
export interface BucketInput {
  /** False for the `no-shift` bucket: under `shift-calendar` its planned busy time is 0. */
  readonly scheduled: boolean;
  /** Time per state in the bucket, integer ms; missing states are 0. */
  readonly stateMs: Readonly<Partial<Record<OeeState, Millis>>>;
  /** The Stopped pieces of the bucket; their `ms` must sum to `stateMs.Stopped`. */
  readonly stops: readonly StopPiece[];
  /** Cycles whose `sourceTime` lies in the bucket, per product and result. */
  readonly cycles: readonly CycleCount[];
  /** The machine's operation, to look up its ideal cycle times. */
  readonly operation: string;
  /** Ideal cycle time in integer ms per product and operation (plant-config `idealCycleMs`). */
  readonly idealCycleMs: Readonly<Record<string, Readonly<Record<string, Millis>>>>;
}

/** Summable totals of one or more buckets, all in integer ms or counts. */
export interface OeeTotals {
  /** Time per state, whatever it counts as. */
  readonly stateMs: Readonly<Record<OeeState, bigint>>;
  /** Time per state inside planned busy time: 0 for excluded states and unscheduled buckets. */
  readonly plannedStateMs: Readonly<Record<OeeState, bigint>>;
  /** Time outside planned busy time: excluded states, or the whole bucket when not scheduled. */
  readonly excludedMs: bigint;
  readonly plannedBusyMs: bigint;
  readonly actualProductionMs: bigint;
  /** Stopped intervals at or above the threshold, inside planned busy time. */
  readonly longStopMs: bigint;
  /** Stopped intervals below the threshold, inside planned busy time (part of APT). */
  readonly microStopMs: bigint;
  /** Σ ideal cycle ms × produced count, of scheduled buckets only. */
  readonly idealMs: bigint;
  readonly good: bigint;
  readonly scrap: bigint;
  readonly rework: bigint;
  /** good + scrap + rework, of scheduled buckets only. */
  readonly produced: bigint;
  /**
   * Cycles of unscheduled (`no-shift`) buckets: reported, but kept out of P and Q, so a sum over
   * shift and no-shift buckets stays meaningful.
   */
  readonly unplanned: {
    readonly good: bigint;
    readonly produced: bigint;
    readonly idealMs: bigint;
  };
  /** An open Stopped interval is counted as a micro-stop for now. */
  readonly provisional: boolean;
}

export interface OeeLosses {
  readonly availability: {
    readonly own: {
      readonly stopped: bigint;
      readonly down: bigint;
      readonly setup: bigint;
      readonly idle: bigint;
      readonly total: bigint;
    };
    readonly external: {
      readonly starved: bigint;
      readonly blocked: bigint;
      readonly total: bigint;
    };
  };
  readonly performance: {
    readonly microStops: bigint;
    /** APT − micro-stops − ideal time; negative when cycles finished faster than ideal. */
    readonly speed: bigint;
    readonly total: bigint;
  };
  /** Ideal time × (1 − Q): the ideal time of the parts that were not good, in ms. */
  readonly quality: Fraction;
}

export interface OeeResult {
  /** APT / PBT; null when PBT = 0. */
  readonly availability: Fraction | null;
  /** Ideal time / APT, not clamped; null when PBT = 0 or APT = 0. */
  readonly performance: Fraction | null;
  /** good / produced; null when PBT = 0 or nothing was produced. */
  readonly quality: Fraction | null;
  /** (ideal × good) / (PBT × produced), 0 when nothing was produced; null when PBT = 0 or APT = 0 with counts. */
  readonly oee: Fraction | null;
  /** Cycles were counted although APT = 0: the inputs disagree. */
  readonly anomaly: boolean;
  readonly provisional: boolean;
  readonly totals: OeeTotals;
  /** null when PBT = 0: nothing was planned, so nothing was lost. */
  readonly losses: OeeLosses | null;
}

function integer(value: number, what: string): bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${what} must be a non-negative integer, got ${String(value)}`);
  }
  return BigInt(value);
}

function emptyStates(): Record<OeeState, bigint> {
  return Object.fromEntries(OEE_STATES.map((state) => [state, 0n])) as Record<OeeState, bigint>;
}

/** The totals of one machine's bucket. Throws on inputs that are not integers or disagree. */
export function bucketTotals(input: BucketInput, config: OeeConfig): OeeTotals {
  const threshold = integer(config.microStopThresholdMs, 'microStopThresholdMs');
  const stateMs = emptyStates();
  for (const [state, ms] of Object.entries(input.stateMs) as [OeeState, Millis][]) {
    if (!OEE_STATES.includes(state)) {
      throw new RangeError(`unknown state "${state}"`);
    }
    stateMs[state] = integer(ms, `${state} time`);
  }
  const elapsed = OEE_STATES.reduce((sum, state) => sum + stateMs[state], 0n);

  let microStops = 0n;
  let stopped = 0n;
  let provisional = false;
  for (const stop of input.stops) {
    const ms = integer(stop.ms, 'stop piece');
    const whole = integer(stop.wholeMs, 'whole stop length');
    if (whole < ms) {
      throw new RangeError(`a stop piece of ${String(ms)} ms is longer than its interval`);
    }
    stopped += ms;
    if (whole < threshold) {
      microStops += ms;
      provisional ||= stop.open === true;
    }
  }
  if (stopped !== stateMs.Stopped) {
    throw new RangeError(
      `stop pieces sum to ${String(stopped)} ms but Stopped time is ${String(stateMs.Stopped)} ms`,
    );
  }

  const counts = { good: 0n, scrap: 0n, rework: 0n };
  let idealMs = 0n;
  for (const cycle of input.cycles) {
    if (!CYCLE_RESULTS.includes(cycle.result)) {
      throw new RangeError(`unknown cycle result "${cycle.result}"`);
    }
    const count = integer(cycle.count, `${cycle.product} ${cycle.result} count`);
    const ideal = input.idealCycleMs[cycle.product]?.[input.operation];
    if (ideal === undefined) {
      throw new RangeError(`no ideal cycle time for ${cycle.product} at ${input.operation}`);
    }
    counts[cycle.result] += count;
    idealMs += integer(ideal, `ideal cycle time of ${cycle.product}`) * count;
  }

  const produced = counts.good + counts.scrap + counts.rework;
  const planned = input.scheduled;
  const plannedStateMs = emptyStates();
  if (planned) {
    for (const state of OEE_STATES) {
      plannedStateMs[state] = EXCLUDED_STATES.includes(state) ? 0n : stateMs[state];
    }
  }
  const plannedBusyMs = OEE_STATES.reduce((sum, state) => sum + plannedStateMs[state], 0n);
  return {
    stateMs,
    plannedStateMs,
    excludedMs: elapsed - plannedBusyMs,
    plannedBusyMs,
    actualProductionMs: planned ? stateMs.Running + microStops : 0n,
    longStopMs: planned ? stateMs.Stopped - microStops : 0n,
    microStopMs: planned ? microStops : 0n,
    idealMs: planned ? idealMs : 0n,
    good: planned ? counts.good : 0n,
    scrap: planned ? counts.scrap : 0n,
    rework: planned ? counts.rework : 0n,
    produced: planned ? produced : 0n,
    unplanned: planned
      ? { good: 0n, produced: 0n, idealMs: 0n }
      : { good: counts.good, produced, idealMs },
    provisional: planned && provisional,
  };
}

/** The sum of several totals: hours into a shift, or machines into a work center. */
export function sumTotals(all: readonly OeeTotals[]): OeeTotals {
  const stateMs = emptyStates();
  const plannedStateMs = emptyStates();
  for (const totals of all) {
    for (const state of OEE_STATES) {
      stateMs[state] += totals.stateMs[state];
      plannedStateMs[state] += totals.plannedStateMs[state];
    }
  }
  const sum = (
    key: Exclude<keyof OeeTotals, 'stateMs' | 'plannedStateMs' | 'unplanned' | 'provisional'>,
  ): bigint => all.reduce((total, totals) => total + totals[key], 0n);
  return {
    stateMs,
    plannedStateMs,
    excludedMs: sum('excludedMs'),
    plannedBusyMs: sum('plannedBusyMs'),
    actualProductionMs: sum('actualProductionMs'),
    longStopMs: sum('longStopMs'),
    microStopMs: sum('microStopMs'),
    idealMs: sum('idealMs'),
    good: sum('good'),
    scrap: sum('scrap'),
    rework: sum('rework'),
    produced: sum('produced'),
    unplanned: {
      good: all.reduce((total, totals) => total + totals.unplanned.good, 0n),
      produced: all.reduce((total, totals) => total + totals.unplanned.produced, 0n),
      idealMs: all.reduce((total, totals) => total + totals.unplanned.idealMs, 0n),
    },
    provisional: all.some((totals) => totals.provisional),
  };
}

/**
 * Losses in ms, inside planned busy time: PBT = APT + own + external availability loss, and
 * APT = micro-stops + speed loss + ideal time. Speed loss is negative where cycles credited to the
 * bucket have more ideal time than its APT. Only called when PBT > 0.
 */
function losses(totals: OeeTotals): OeeLosses {
  const planned = totals.plannedStateMs;
  const own = {
    stopped: totals.longStopMs,
    down: planned.Down,
    setup: planned.Setup,
    idle: planned.Idle,
  };
  const external = { starved: planned.Starved, blocked: planned.Blocked };
  const speed = totals.actualProductionMs - totals.microStopMs - totals.idealMs;
  return {
    availability: {
      own: { ...own, total: own.stopped + own.down + own.setup + own.idle },
      external: { ...external, total: external.starved + external.blocked },
    },
    performance: {
      microStops: totals.microStopMs,
      speed,
      total: totals.microStopMs + speed,
    },
    quality:
      totals.produced > 0n
        ? fraction(totals.idealMs * (totals.produced - totals.good), totals.produced)
        : fraction(0n),
  };
}

/** A, P, Q and OEE from totals, with the edge cases of ADR-0021. */
export function oeeFromTotals(totals: OeeTotals): OeeResult {
  const pbt = totals.plannedBusyMs;
  const apt = totals.actualProductionMs;
  const anomaly = pbt > 0n && apt === 0n && totals.produced > 0n;
  let oee: Fraction | null = null;
  if (pbt > 0n && totals.produced === 0n) {
    oee = fraction(0n);
  } else if (pbt > 0n && apt > 0n) {
    // A × P × Q with APT cancelled: one exact fraction, never a product of rounded parts.
    oee = fraction(totals.idealMs * totals.good, pbt * totals.produced);
  }
  return {
    availability: pbt > 0n ? fraction(apt, pbt) : null,
    performance: pbt > 0n && apt > 0n ? fraction(totals.idealMs, apt) : null,
    quality: pbt > 0n && totals.produced > 0n ? fraction(totals.good, totals.produced) : null,
    oee,
    anomaly,
    provisional: totals.provisional,
    totals,
    losses: pbt > 0n ? losses(totals) : null,
  };
}

/** OEE of one machine's bucket. */
export const bucketOee = (input: BucketInput, config: OeeConfig): OeeResult =>
  oeeFromTotals(bucketTotals(input, config));

/**
 * OEE of a work center from the sums of its machines' inputs: ΣAPT/ΣPBT, Σideal/ΣAPT and
 * Σgood/Σproduced. Time-weighted, not a line-throughput OEE.
 */
export const workCenterOee = (inputs: readonly BucketInput[], config: OeeConfig): OeeResult =>
  oeeFromTotals(sumTotals(inputs.map((input) => bucketTotals(input, config))));
