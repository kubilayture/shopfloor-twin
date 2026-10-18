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
}

export type HeadTime =
  /** The job is head from `at`. */
  | {
      readonly kind: 'head';
      readonly at: Millis;
      readonly source: 'accepted' | 'acceptedAt' | 'previous-completed';
    }
  /** The previous job on the CNC has not completed, and this one has not started: not head yet. */
  | { readonly kind: 'waiting' }
  /**
   * The facts can't tell: the job's acceptance is unknown (neither the fact nor `acceptedAt`), or
   * the previous job's `completed` fact is lost or missing while this job has started.
   */
  | {
      readonly kind: 'unknown';
      readonly reason:
        'accepted-unknown' | 'previous-completed-lost' | 'previous-completed-missing';
    };

/** The head time of every job of one CNC's queue, given in queue (acceptance) order. */
export function headTimes(queue: readonly QueuedJob[]): HeadTime[] {
  return queue.map((job, i): HeadTime => {
    const previous = i > 0 ? queue[i - 1] : undefined;
    let previousEnd: Millis | undefined;
    if (previous !== undefined) {
      if (previous.completed !== undefined) {
        previousEnd = previous.completed;
      } else if (previous.completedLost === true) {
        return { kind: 'unknown', reason: 'previous-completed-lost' };
      } else if (job.started !== undefined || job.completed !== undefined) {
        return { kind: 'unknown', reason: 'previous-completed-missing' };
      } else {
        return { kind: 'waiting' };
      }
    }
    const accepted = job.accepted ?? job.acceptedAt;
    if (accepted === undefined) {
      return { kind: 'unknown', reason: 'accepted-unknown' };
    }
    if (previousEnd !== undefined && previousEnd > accepted) {
      return { kind: 'head', at: previousEnd, source: 'previous-completed' };
    }
    return {
      kind: 'head',
      at: accepted,
      source: job.accepted === undefined ? 'acceptedAt' : 'accepted',
    };
  });
}

export interface JobWindow extends Range {
  /** The job has not completed by the cut-off (or its `completed` fact is lost): provisional. */
  readonly open: boolean;
  /**
   * The head time is unknown, so the window starts at the job's `started` fact and leaves out its
   * changeover: provisional, and never final.
   */
  readonly headTimeUnknown: boolean;
}

/**
 * The job's window on its CNC up to `until` (the caller's cut-off: final-through on the MES side,
 * the snapshot time in the ground truth), or undefined when it has none yet: a waiting job, a head
 * time after `until`, or an unknown head time and no `started` fact.
 */
export function jobWindow(job: QueuedJob, head: HeadTime, until: Millis): JobWindow | undefined {
  let from: Millis;
  let headTimeUnknown = false;
  if (head.kind === 'head') {
    from = head.at;
  } else if (head.kind === 'unknown' && job.started !== undefined) {
    from = job.started;
    headTimeUnknown = true;
  } else {
    return undefined;
  }
  if (from > until) return undefined;
  const closed = job.completed !== undefined && job.completed <= until;
  return { from, to: closed ? (job.completed ?? until) : until, open: !closed, headTimeUnknown };
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
  /** A window is still open: the order's OEE is provisional. */
  readonly open: boolean;
  /** A job's head time is unknown (a lost fact): provisional, and never final. */
  readonly headTimeUnknown: boolean;
}

/**
 * The order's OEE. `order.provisional` is set when a micro-stop is provisional, a window is open or a
 * head time is unknown; finality beyond that (every fact and unit final) is the caller's.
 */
export function orderOee(input: OrderOeeInput, config: OeeConfig): OrderOeeResult {
  const jobs: Record<string, OeeResult | null> = {};
  const all = [];
  let open = false;
  let headTimeUnknown = false;
  for (const job of input.jobs) {
    if (job.window === undefined) {
      jobs[job.id] = null;
      continue;
    }
    open ||= job.window.open;
    headTimeUnknown ||= job.window.headTimeUnknown;
    const totals = sumTotals(
      windowInputs({
        window: job.window,
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
      provisional: result.provisional || job.window.open || job.window.headTimeUnknown,
    };
    all.push(totals);
  }
  const order = oeeFromTotals(sumTotals(all));
  return {
    order: { ...order, provisional: order.provisional || open || headTimeUnknown },
    jobs,
    open,
    headTimeUnknown,
  };
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
