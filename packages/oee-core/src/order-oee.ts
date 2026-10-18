/**
 * Order OEE over job windows (ADR-0036, Phase 9 plan): a job is the head of its CNC's queue from
 * `max(its accepted fact, the previous job's completed fact)`; its window runs from there to its
 * `completed` fact, so the changeover before its `started` fact counts against the order that caused
 * it. Inside the windows the CNC's states give planned busy time and actual production time by the
 * equipment rules (ADR-0021); produced and good are the job's OP10 cycles, attributed by unit
 * (ADR-0031) by the caller. Beside it, the order's first-pass yield across the routing.
 */
import { fraction, type Fraction } from './fraction.ts';
import type { Millis, StateInterval } from './intervals.ts';
import {
  CYCLE_RESULTS,
  bucketTotals,
  oeeFromTotals,
  sumTotals,
  type BucketInput,
  type CycleCount,
  type CycleResult,
  type OeeConfig,
  type OeeResult,
  type OeeState,
} from './oee.ts';
import { intersect, normalize, subtract, type Range } from './ranges.ts';

/** The cause of an orders-mode CNC's Idle with no startable job (ADR-0030). */
export const NO_ORDER_CAUSE = 'NO-ORDER';

/** One job of a CNC's queue, as its job facts (and the command result) tell it. */
export interface QueuedJob {
  readonly id: string;
  /** Plant time of the device's `accepted` fact; undefined while it is unknown (lost or not received). */
  readonly accepted?: Millis;
  /** The `accepted` fact is lost (a written-off gap), not merely not received yet. */
  readonly acceptedLost?: boolean;
  /**
   * The command result's `acceptedAt` (`uns.cmd-res/1`): the plant time of the same `accepted` fact,
   * learnt on the command path. Used only when `accepted` is unknown.
   */
  readonly acceptedAt?: Millis;
  /** Plant time of the job's `started` fact (its first blank, after any changeover). */
  readonly started?: Millis;
  /** Plant time of the job's `completed` fact (the end of its last OP10 cycle). */
  readonly completed?: Millis;
  /** The `completed` fact is lost (a written-off gap): the job ended, but when is unknown. */
  readonly completedLost?: boolean;
  /** Blanks to machine: the job's number of OP10 cycles (ADR-0030). */
  readonly quantity?: number;
  /**
   * The end times of the job's OP10 cycles known so far, attributed by unit (ADR-0031). With all
   * `quantity` of them known, the last one is the job's completion even when its `completed` fact
   * is lost (ADR-0030: `completed` is the end of the last OP10 cycle).
   */
  readonly cycleEnds?: readonly Millis[];
}

/**
 * The job's completion: its `completed` fact, or, when that fact is lost and every one of its
 * `quantity` OP10 cycles is known, the end of the last of them. Undefined otherwise.
 */
export function completionOf(job: QueuedJob): Millis | undefined {
  if (job.completed !== undefined) return job.completed;
  const ends = job.cycleEnds ?? [];
  if (job.quantity !== undefined && ends.length > job.quantity) {
    throw new RangeError(
      `job ${job.id} has ${String(ends.length)} OP10 cycles but a quantity of ${String(job.quantity)}`,
    );
  }
  if (job.completedLost !== true || job.quantity === undefined || job.quantity === 0) {
    return undefined;
  }
  if (ends.length < job.quantity) return undefined;
  return ends.reduce((last, end) => (end > last ? end : last));
}

/** Why a head time is unknown; `previous-completed-missing` is transient, the lost ones are not. */
export type HeadUnknownReason =
  'accepted-unknown' | 'accepted-lost' | 'previous-completed-lost' | 'previous-completed-missing';

export type HeadTime =
  /** The job is head from `at`. */
  | {
      readonly kind: 'head';
      readonly at: Millis;
      /** `previous-last-cycle`: the previous job's `completed` fact is lost, its last cycle known. */
      readonly source: 'accepted' | 'acceptedAt' | 'previous-completed' | 'previous-last-cycle';
    }
  /** The previous job on the CNC has not completed, and this one has not started: not head yet. */
  | { readonly kind: 'waiting' }
  /**
   * The facts can't tell: the job's acceptance is unknown (neither the fact nor `acceptedAt`;
   * `accepted-lost` when the fact is lost), or the previous job's completion is lost or missing
   * while this job has started.
   */
  | { readonly kind: 'unknown'; readonly reason: HeadUnknownReason };

/** Unknown head times that no later fact can resolve: the order is never final. */
const LOST_REASONS: readonly HeadUnknownReason[] = ['accepted-lost', 'previous-completed-lost'];

/** The head time of every job of one CNC's queue, given in queue (acceptance) order. */
export function headTimes(queue: readonly QueuedJob[]): HeadTime[] {
  return queue.map((job, i): HeadTime => {
    const previous = i > 0 ? queue[i - 1] : undefined;
    let previousEnd: Millis | undefined;
    if (previous !== undefined) {
      previousEnd = completionOf(previous);
      if (previousEnd === undefined) {
        if (previous.completedLost === true) {
          return { kind: 'unknown', reason: 'previous-completed-lost' };
        }
        if (job.started !== undefined || job.completed !== undefined) {
          return { kind: 'unknown', reason: 'previous-completed-missing' };
        }
        return { kind: 'waiting' };
      }
    }
    const accepted = job.accepted ?? job.acceptedAt;
    if (accepted === undefined) {
      return {
        kind: 'unknown',
        reason: job.acceptedLost === true ? 'accepted-lost' : 'accepted-unknown',
      };
    }
    if (previous !== undefined && previousEnd !== undefined && previousEnd > accepted) {
      return {
        kind: 'head',
        at: previousEnd,
        source: previous.completed === undefined ? 'previous-last-cycle' : 'previous-completed',
      };
    }
    return {
      kind: 'head',
      at: accepted,
      source: job.accepted === undefined ? 'acceptedAt' : 'accepted',
    };
  });
}

export interface JobWindow extends Range {
  /** The job has not completed by the cut-off: provisional until it does (transient). */
  readonly open: boolean;
  /**
   * The head time is unknown, so the window starts at the job's `started` fact and leaves out its
   * changeover: provisional. Final again once the missing fact arrives, unless `lost`.
   */
  readonly headTimeUnknown: boolean;
  /** Why, when `headTimeUnknown`. */
  readonly headUnknownReason?: HeadUnknownReason;
  /**
   * The job's `completed` fact is lost and its cycles don't tell its end: the window ends at the
   * next job's `started` fact (or the cut-off, `open`) and is provisional.
   */
  readonly endLost: boolean;
  /** A fact this window needs is lost for good: provisional and never final. */
  readonly lost: boolean;
}

/**
 * The job's window on its CNC up to `until` (the caller's cut-off: final-through on the MES side,
 * the snapshot time in the ground truth), or undefined when it has none yet: a waiting job, a head
 * time after `until`, or an unknown head time and no `started` fact. `next` is the following job on
 * the same CNC: its `started` fact caps a window whose end is lost. Throws when the job's completion
 * lies before the window's start.
 */
export function jobWindow(
  job: QueuedJob,
  head: HeadTime,
  until: Millis,
  next?: QueuedJob,
): JobWindow | undefined {
  let from: Millis;
  let headUnknownReason: HeadUnknownReason | undefined;
  if (head.kind === 'head') {
    from = head.at;
  } else if (head.kind === 'unknown' && job.started !== undefined) {
    from = job.started;
    headUnknownReason = head.reason;
  } else {
    return undefined;
  }
  const completion = completionOf(job);
  if (completion !== undefined && completion < from) {
    throw new RangeError(
      `job ${job.id}: its completion (${String(completion)}) is before its window starts (${String(from)}); the job facts are inconsistent`,
    );
  }
  if (from > until) return undefined;
  let to = until;
  let open = true;
  let endLost = false;
  if (completion !== undefined && completion <= until) {
    to = completion;
    open = false;
  } else if (completion === undefined && job.completedLost === true) {
    endLost = true;
    const cap = next?.started;
    if (cap !== undefined && cap >= from && cap <= until) {
      to = cap;
      open = false;
    }
  }
  return {
    from,
    to,
    open,
    headTimeUnknown: headUnknownReason !== undefined,
    ...(headUnknownReason === undefined ? {} : { headUnknownReason }),
    endLost,
    lost: endLost || (headUnknownReason !== undefined && LOST_REASONS.includes(headUnknownReason)),
  };
}

/** One state interval of a machine; `open` while it is still running at its `to` (the cut-off). */
export interface TimelineInterval extends StateInterval<OeeState> {
  readonly open?: boolean;
}

/** Cycles of one product and result completed at `at` (scheduled or not by that time). */
export interface TimedCycleCount extends CycleCount {
  readonly at: Millis;
}

export interface WindowInput {
  readonly window: Range;
  /** The machine's state intervals, whole (a Stopped interval's whole length decides micro-stops). */
  readonly intervals: readonly TimelineInterval[];
  /** The scheduled time (the shift buckets); the rest of the window is like `no-shift`. */
  readonly scheduled: readonly Range[];
  /** The cycles credited to the window (the caller attributes them, by unit for a job). */
  readonly cycles: readonly TimedCycleCount[];
  readonly operation: string;
  readonly idealCycleMs: BucketInput['idealCycleMs'];
}

const isScheduledAt = (at: Millis, scheduled: readonly Range[]): boolean =>
  scheduled.some((range) => at >= range.from && at < range.to);

function bucketPart(
  input: WindowInput,
  parts: readonly Range[],
  cycles: readonly TimedCycleCount[],
  scheduled: boolean,
): BucketInput | undefined {
  const stateMs: Partial<Record<OeeState, Millis>> = {};
  const stops: { ms: Millis; wholeMs: Millis; open: boolean }[] = [];
  let noOrderIdleMs = 0;
  for (const interval of input.intervals) {
    for (const piece of intersect([interval], parts)) {
      const ms = piece.to - piece.from;
      stateMs[interval.state] = (stateMs[interval.state] ?? 0) + ms;
      if (interval.state === 'Stopped') {
        stops.push({ ms, wholeMs: interval.to - interval.from, open: interval.open === true });
      } else if (interval.state === 'Idle' && interval.cause === NO_ORDER_CAUSE) {
        noOrderIdleMs += ms;
      }
    }
  }
  if (Object.keys(stateMs).length === 0 && cycles.length === 0) return undefined;
  return {
    scheduled,
    stateMs,
    ...(noOrderIdleMs > 0 ? { noOrderIdleMs } : {}),
    stops,
    cycles: cycles.map(({ product, result, count }) => ({ product, result, count })),
    operation: input.operation,
    idealCycleMs: input.idealCycleMs,
  };
}

/**
 * The `oee-core` inputs of a window: one bucket for its scheduled part (the shift buckets) and one
 * for the rest, each left out when it holds no time and no cycle. A cycle is scheduled when its
 * `at` lies in a scheduled range, as a bucket's cycles are those whose `sourceTime` lies in it; the
 * caller decides which cycles belong to the window (a job's last cycle ends at its `completed`
 * fact, the window's end).
 */
export function windowInputs(input: WindowInput): BucketInput[] {
  const window = normalize([input.window]);
  const scheduledCycles = input.cycles.filter((c) => isScheduledAt(c.at, input.scheduled));
  const otherCycles = input.cycles.filter((c) => !isScheduledAt(c.at, input.scheduled));
  return [
    bucketPart(input, intersect(window, input.scheduled), scheduledCycles, true),
    bucketPart(input, subtract(window, input.scheduled), otherCycles, false),
  ].filter((part) => part !== undefined);
}

export interface OrderJobInput {
  readonly id: string;
  /** From `jobWindow`; undefined when the job has no window yet. */
  readonly window: JobWindow | undefined;
  /** The CNC's state intervals. */
  readonly intervals: readonly TimelineInterval[];
  /** The job's cycles at its operation, attributed by unit (ADR-0031). */
  readonly cycles: readonly TimedCycleCount[];
  readonly operation: string;
}

export interface OrderOeeInput {
  readonly jobs: readonly OrderJobInput[];
  readonly scheduled: readonly Range[];
  readonly idealCycleMs: BucketInput['idealCycleMs'];
}

export interface OrderOeeResult {
  /** A, P, Q and OEE over every job window of the order, summed (time-weighted, ADR-0021 (b)). */
  readonly order: OeeResult;
  /** The same per job, by job id; null for a job without a window yet. */
  readonly jobs: Readonly<Record<string, OeeResult | null>>;
  /** A window is still open: provisional until the job completes. */
  readonly open: boolean;
  /** A job has no window yet (waiting, or its head time unknown and no `started` fact): provisional. */
  readonly pending: boolean;
  /** A job's head time is unknown: provisional; final again once the fact arrives, unless `lost`. */
  readonly headTimeUnknown: boolean;
  /** A job's end is lost (`completed` lost and its cycles don't tell it): provisional. */
  readonly endLost: boolean;
  /** A fact a window needs is lost for good: provisional and never final. */
  readonly lost: boolean;
}

/**
 * The order's OEE. `order.provisional` is set when a micro-stop is provisional, a job has no window
 * yet, a window is open, a head time is unknown or an end is lost; finality beyond that (every fact
 * and unit final) is the caller's, and an order with `lost` is never final.
 */
export function orderOee(input: OrderOeeInput, config: OeeConfig): OrderOeeResult {
  const jobs: Record<string, OeeResult | null> = {};
  const all = [];
  const flags = {
    open: false,
    pending: false,
    headTimeUnknown: false,
    endLost: false,
    lost: false,
  };
  for (const job of input.jobs) {
    const window = job.window;
    if (window === undefined) {
      jobs[job.id] = null;
      flags.pending = true;
      continue;
    }
    flags.open ||= window.open;
    flags.headTimeUnknown ||= window.headTimeUnknown;
    flags.endLost ||= window.endLost;
    flags.lost ||= window.lost;
    const totals = sumTotals(
      windowInputs({
        window,
        intervals: job.intervals,
        scheduled: input.scheduled,
        cycles: job.cycles,
        operation: job.operation,
        idealCycleMs: input.idealCycleMs,
      }).map((part) => bucketTotals(part, config)),
    );
    const result = oeeFromTotals(totals);
    jobs[job.id] = {
      ...result,
      provisional: result.provisional || window.open || window.headTimeUnknown || window.endLost,
    };
    all.push(totals);
  }
  const order = oeeFromTotals(sumTotals(all));
  const provisional =
    order.provisional || flags.open || flags.pending || flags.headTimeUnknown || flags.endLost;
  return { order: { ...order, provisional }, jobs, ...flags };
}

/** One unit's operation records in plant-time order (ADR-0031). */
export interface UnitRoute {
  readonly records: readonly { readonly operation: string; readonly result: CycleResult }[];
}

export interface FirstPassYield {
  /** Units packed good with every record good: no rework, no retest. */
  readonly firstPassGood: bigint;
  /** Units started (blanks taken). */
  readonly started: bigint;
  /** firstPassGood / started; null when nothing was started. */
  readonly yield: Fraction | null;
}

/**
 * The order's first-pass yield across the routing: units packed good at the last operation on
 * their first pass / units started. Beside the order OEE, never multiplied into it: OP10's quality
 * alone hides OP40's leak scrap.
 */
export function firstPassYield(input: {
  readonly started: number;
  readonly units: readonly UnitRoute[];
  readonly lastOperation: string;
}): FirstPassYield {
  if (!Number.isSafeInteger(input.started) || input.started < 0) {
    throw new RangeError(
      `units started must be a non-negative integer, got ${String(input.started)}`,
    );
  }
  let good = 0n;
  for (const unit of input.units) {
    for (const record of unit.records) {
      if (!CYCLE_RESULTS.includes(record.result)) {
        throw new RangeError(`unknown cycle result "${record.result}"`);
      }
    }
    const packed = unit.records.some(
      (record) => record.operation === input.lastOperation && record.result === 'good',
    );
    if (packed && unit.records.every((record) => record.result === 'good')) good += 1n;
  }
  const started = BigInt(input.started);
  if (good > started) {
    throw new RangeError(
      `${String(good)} units packed good on their first pass, but ${String(started)} started`,
    );
  }
  return { firstPassGood: good, started, yield: started > 0n ? fraction(good, started) : null };
}
