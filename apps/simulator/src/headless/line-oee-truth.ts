/**
 * The order and line OEE ground truth (#230, P9-03, ADR-0036): `line-oee.json` (`sim-line-oee/1`)
 * beside each golden `summary.json`, and `lineOee` in the live `GET /ground-truth` (control API 1.8).
 * Computed with `oee-core`'s Phase 9 functions from the plant events only, with the conventions the
 * MES (P9-04, P9-05) derives from device facts:
 *
 * - **Bottleneck:** `deriveBottlenecks` from the routing and the equipment (ASM-01 for both
 *   products), so no configuration key and neither configuration hash changes.
 * - **Attribution:** an OP10 cycle belongs to the job whose `started` fact is the latest on its CNC
 *   before it (ADR-0031, the started-fact rule); the part keeps that job's order for its later
 *   cycles. Blanks taken (`material-consumed` on a CNC) count as the order's units started.
 * - **Job windows:** each CNC's queue holds every accepted job in acceptance order (the truth has
 *   every fact, so no job is lost or unknown), each with its dispatch's `notBefore`; `jobWindows`
 *   gives head times (`max(accepted, previous completed, notBefore)`, ADR-0036 amendment) and
 *   windows up to the cut-off. Order OEE (`orderOee`) over the windows with the CNC's state intervals, the attributed
 *   OP10 cycles and the OP10 ideal cycle; first-pass yield (`firstPassYield`) beside it.
 * - **Order completion** (ADR-0031): every job completed, every blank taken, every unit terminal
 *   (packed good at the last operation, or scrapped); the time of the latest record, the order
 *   truth's `completedAt`.
 * - **Line planned busy time** (`linePlannedBusyMs`): scheduled time is the shift buckets (no
 *   `no-shift`); planned stops are the calendar's breaks and the Maintenance intervals of the
 *   bottleneck's machines; in orders mode only where an order is in progress, from the earliest
 *   head time of its jobs to its completion (or the cut-off while it is open).
 * - **Good packed:** `good` cycles at the last operation, bucketed by their time; per order its own.
 *
 * Every value is derived from the events before the cut-off, so the section at a cut-off `t` equals
 * what a run that ended at `t` gives (`?asOf`, tested).
 */
import {
  deriveBottlenecks,
  firstPassYield,
  formatFraction,
  intervalsFromFacts,
  jobWindows,
  lineOee,
  linePlannedBusyMs,
  orderOee,
  toDecimal,
  type CycleResult,
  type Fraction,
  type HeadTime,
  type JobWindow,
  type OeeConfig,
  type OeeState,
  type QueuedJob,
  type Range,
  type TimedCycleCount,
  type TimelineInterval,
} from '@shopfloor/oee-core';
import { idealCycleMs, type PlantConfig } from '@shopfloor/plant-config';
import {
  HOUR,
  NO_SHIFT,
  hourStart,
  shiftBoundaries,
  shiftKeyAt,
  shiftSegments,
} from '@shopfloor/shift-calendar';
import type { SimTime } from '@shopfloor/sim-core';
import type { PlantEvent, ProductionMode } from '../plant/line.ts';
import { resultJson, type OeeResultJson, type RatioJson } from './oee-truth.ts';
import { isoTime } from './serialize.ts';

export const LINE_OEE_SCHEMA = 'sim-line-oee/1';

const DAY = 24 * HOUR;

export interface BottleneckJson {
  readonly operation: string;
  readonly equipment: readonly string[];
  readonly idealCycleMs: number;
  /** Ideal cycle ÷ machines on the operation, `num/den`. */
  readonly effectiveCycleMs: string;
}

export interface PlannedStopJson {
  readonly from: string;
  readonly to: string;
  /** `break` (the calendar) or `maintenance` (a bottleneck machine in Maintenance). */
  readonly kind: 'break' | 'maintenance';
  /** The machine, for `maintenance`. */
  readonly equipment?: string;
}

/** `lineOee` of one bucket or order, with the bucket's span. */
export interface LineValueJson {
  readonly from: string;
  readonly to: string;
  readonly plannedBusyMs: number;
  /** Units packed good, per product. */
  readonly good: Readonly<Record<string, number>>;
  /** Σ good × the bottleneck's effective cycle, ms, `num/den`. */
  readonly idealMs: string;
  /** idealMs / plannedBusyMs, not capped; null when the planned busy time is 0. */
  readonly oee: RatioJson | null;
  readonly aboveOne: boolean;
  /** The bucket (or the order's in-progress time) reaches past the cut-off. */
  readonly provisional: boolean;
}

export interface JobOeeJson {
  readonly machine: string;
  /**
   * `max(accepted, previous job's completed, notBefore)` on the CNC (ADR-0036 and its amendment),
   * or null while the job is waiting.
   */
  readonly headTime: string | null;
  readonly headSource: 'accepted' | 'previous-completed' | 'notBefore' | null;
  readonly window: { readonly from: string; readonly to: string; readonly open: boolean } | null;
  /** OP10 cycles attributed by the started-fact rule. */
  readonly cycles: number;
  readonly oee: OeeResultJson | null;
}

export interface OrderOeeJson {
  readonly product: string;
  /** Command ids in acceptance order. */
  readonly jobs: readonly string[];
  readonly jobOee: Readonly<Record<string, JobOeeJson>>;
  /** Order OEE over its job windows (time-weighted sum). */
  readonly oee: OeeResultJson;
  readonly open: boolean;
  readonly pending: boolean;
  readonly headTimeUnknown: boolean;
  readonly endLost: boolean;
  readonly lost: boolean;
  readonly firstPassYield: {
    readonly firstPassGood: number;
    readonly started: number;
    readonly yield: RatioJson | null;
  };
  /** ADR-0031 completion; null while the order is open. */
  readonly completedAt: string | null;
  /** Its line OEE over its in-progress time with its own good units (not additive); null before. */
  readonly line: LineValueJson | null;
}

/** `line-oee.json` without `schema` and `run`: what the live ground truth serves as `lineOee`. */
export interface LineOeeSection {
  readonly analysisConfigSha256: string;
  readonly config: OeeConfig & { readonly productionMode: ProductionMode };
  readonly bottlenecks: Readonly<Record<string, BottleneckJson>>;
  readonly plannedStops: readonly PlannedStopJson[];
  /** Orders mode: each order's in-progress time (empty in schedule mode). */
  readonly inProgress: readonly {
    readonly orderId: string;
    readonly from: string;
    readonly to: string;
    readonly open: boolean;
  }[];
  readonly line: {
    /** Keyed by the UTC hour start, every hour of the run up to the cut-off. */
    readonly hours: Readonly<Record<string, LineValueJson>>;
    /** Keyed like the summary's buckets (`2026-10-12/A`), every shift bucket the run touches. */
    readonly shifts: Readonly<Record<string, LineValueJson>>;
  };
  /** Orders mode: order OEE, first-pass yield and line OEE per order; empty in schedule mode. */
  readonly orders: Readonly<Record<string, OrderOeeJson>>;
}

type Recorded = Extract<
  PlantEvent,
  { type: 'state' | 'cycle-complete' | 'job' | 'material-consumed' }
>;

const ratio = (f: Fraction | null): RatioJson | null =>
  f === null ? null : { fraction: formatFraction(f), decimal: toDecimal(f) };

const safe = (value: bigint, what: string): number => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError(`${what} ${String(value)} is not safe`);
  return n;
};

const sortedRecord = <T>(entries: Iterable<[string, T]>): Record<string, T> =>
  Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

interface Job {
  readonly id: string;
  readonly machine: string;
  readonly orderId: string;
  readonly product: string;
  readonly quantity: number;
  readonly accepted: SimTime;
  readonly notBefore: SimTime | undefined;
  started?: SimTime;
  completed?: SimTime;
  readonly cycles: TimedCycleCount[];
}

interface Order {
  readonly product: string;
  readonly jobs: string[];
  readonly blanks: Set<number>;
  /** Units (parts with an attributed OP10 cycle) in order of their first cycle. */
  readonly units: number[];
  readonly packed: { at: SimTime; product: string }[];
}

interface Unit {
  readonly orderId: string;
  readonly records: { operation: string; result: CycleResult }[];
  terminalAt?: SimTime;
}

/**
 * Records the plant events order and line OEE need, in log order, and builds the section at any
 * cut-off. Recording keeps state, cycle, job and blank events only.
 */
export class LineOeeTruth {
  readonly #config: PlantConfig;
  readonly #start: SimTime;
  readonly #production: ProductionMode;
  readonly #analysisConfigSha256: string;
  readonly #operation: ReadonlyMap<string, string>;
  readonly #firstOperation: string;
  readonly #lastOperation: string;
  readonly #records: Recorded[] = [];
  readonly #jobNotBefore: (commandId: string) => SimTime | undefined;
  /** Each accepted job's dispatch `notBefore`, learnt when its `accepted` event is recorded. */
  readonly #notBefore = new Map<string, SimTime>();

  /**
   * `jobNotBefore` gives an accepted job's dispatch `notBefore` (the line's job registry): the
   * `accepted` event doesn't carry it, so the event log stays as it is (ADR-0036 amendment).
   */
  constructor(
    config: PlantConfig,
    start: SimTime,
    production: ProductionMode,
    analysisConfigSha256: string,
    jobNotBefore: (commandId: string) => SimTime | undefined = () => undefined,
  ) {
    this.#jobNotBefore = jobNotBefore;
    this.#config = config;
    this.#start = start;
    this.#production = production;
    this.#analysisConfigSha256 = analysisConfigSha256;
    this.#operation = new Map(
      config.plant.areas.flatMap((a) =>
        a.workCenters.flatMap((w) => w.equipment.map((e) => [e.id, e.operation] as const)),
      ),
    );
    this.#firstOperation = config.products.operations[0] ?? 'OP10';
    this.#lastOperation = config.products.operations.at(-1) ?? 'OP50';
  }

  record(event: PlantEvent): void {
    if (
      event.type === 'state' ||
      event.type === 'cycle-complete' ||
      event.type === 'job' ||
      (event.type === 'material-consumed' &&
        this.#operation.get(event.machineId) === this.#firstOperation)
    ) {
      this.#records.push(event);
    }
    if (event.type === 'job' && event.transition === 'accepted') {
      const notBefore = this.#jobNotBefore(event.commandId);
      if (notBefore !== undefined) this.#notBefore.set(event.commandId, notBefore);
    }
  }

  /**
   * The section at `now` (every event recorded so far), or, with `asOf`, as it stood at that plant
   * time: only the events before it, cut there, as a run that ended at `asOf` gives it.
   */
  build(now: SimTime, asOf?: SimTime): LineOeeSection {
    // A cut before the start sees nothing, as at the start.
    const until = Math.max(asOf ?? now, this.#start);
    const records =
      asOf === undefined ? this.#records : this.#records.filter((record) => record.at < asOf);
    return this.#section(records, until);
  }

  #section(records: readonly Recorded[], until: SimTime): LineOeeSection {
    const config = this.#config;
    const start = this.#start;
    const ideal = idealCycleMs(config);
    const equipment = config.plant.areas.flatMap((a) => a.workCenters.flatMap((w) => w.equipment));
    const bottlenecks = deriveBottlenecks({
      operations: config.products.operations,
      equipment,
      idealCycleMs: ideal,
    });
    const effectiveCycleMs = Object.fromEntries(
      Object.entries(bottlenecks).map(([product, b]) => [product, b.effectiveCycleMs]),
    );

    // One pass over the events in log order.
    const facts = new Map<string, { at: SimTime; state: OeeState; cause: string | null }[]>(
      equipment.map((e) => [e.id, [{ at: start, state: 'Off', cause: null }]]),
    );
    const jobs = new Map<string, Job>();
    const queues = new Map<string, Job[]>();
    const orders = new Map<string, Order>();
    const current = new Map<string, Job>();
    const units = new Map<number, Unit>();
    const packed: { at: SimTime; product: string }[] = [];
    for (const record of records) {
      switch (record.type) {
        case 'state':
          facts.get(record.machineId)?.push({
            at: record.at,
            state: record.to,
            cause: record.cause ?? null,
          });
          break;
        case 'job':
          this.#onJob(record, jobs, queues, orders, current);
          break;
        case 'material-consumed': {
          const job = current.get(record.machineId);
          if (job) orders.get(job.orderId)?.blanks.add(record.partId);
          break;
        }
        case 'cycle-complete': {
          const operation = this.#operation.get(record.machineId);
          if (operation === this.#firstOperation) {
            const job = current.get(record.machineId);
            if (job && !units.has(record.partId)) {
              job.cycles.push({
                at: record.at,
                product: record.product,
                result: record.result,
                count: 1,
              });
              units.set(record.partId, { orderId: job.orderId, records: [] });
              orders.get(job.orderId)?.units.push(record.partId);
            }
          }
          const unit = units.get(record.partId);
          if (unit && operation !== undefined) {
            unit.records.push({ operation, result: record.result });
            if (record.result === 'scrap') unit.terminalAt = record.at;
          }
          if (operation === this.#lastOperation && record.result === 'good') {
            packed.push({ at: record.at, product: record.product });
            if (unit) {
              unit.terminalAt = record.at;
              orders.get(unit.orderId)?.packed.push({ at: record.at, product: record.product });
            }
          }
          break;
        }
      }
    }

    // State intervals per machine, the last one open at the cut-off.
    const intervals = new Map<string, TimelineInterval[]>();
    for (const [id, list] of facts) {
      const closed = intervalsFromFacts(list, until);
      // Only the interval of the last fact is still running at the cut-off.
      const lastAt = list.at(-1)?.at;
      intervals.set(
        id,
        closed.map((interval) =>
          interval.from === lastAt && interval.to === until
            ? { ...interval, open: true }
            : interval,
        ),
      );
    }

    // The calendar: scheduled time and breaks inside [start, until).
    const span: Range = { from: start, to: until };
    const scheduled: Range[] = shiftSegments(config.shifts, start, until)
      .filter((segment) => segment.key !== NO_SHIFT)
      .map(({ from, to }) => ({ from, to }));
    const stops: { range: Range; json: PlannedStopJson }[] = [];
    const breakStarts = new Map<string, SimTime>();
    for (const boundary of shiftBoundaries(config.shifts, start - DAY, until + DAY)) {
      const key = `${boundary.shiftDate}/${boundary.shiftId}`;
      if (boundary.action === 'break-start') breakStarts.set(key, boundary.at);
      if (boundary.action !== 'break-end') continue;
      const from = Math.max(breakStarts.get(key) ?? boundary.at, span.from);
      const to = Math.min(boundary.at, span.to);
      if (to > from) {
        stops.push({
          range: { from, to },
          json: { from: isoTime(from), to: isoTime(to), kind: 'break' },
        });
      }
    }
    const bottleneckMachines = [
      ...new Set(Object.values(bottlenecks).flatMap((b) => b.equipment)),
    ].sort();
    for (const machine of bottleneckMachines) {
      for (const interval of intervals.get(machine) ?? []) {
        if (interval.state !== 'Maintenance') continue;
        stops.push({
          range: { from: interval.from, to: interval.to },
          json: {
            from: isoTime(interval.from),
            to: isoTime(interval.to),
            kind: 'maintenance',
            equipment: machine,
          },
        });
      }
    }
    stops.sort((a, b) => a.range.from - b.range.from || a.range.to - b.range.to);
    const plannedStops = stops.map((stop) => stop.range);

    // Head times and windows per CNC queue (acceptance order; every job accepted, none lost).
    const windows = new Map<string, { head: HeadTime; window: JobWindow | undefined }>();
    for (const [machine, queue] of queues) {
      const queued: QueuedJob[] = queue.map((job) => ({
        id: job.id,
        machine,
        accepted: job.accepted,
        ...(job.notBefore === undefined ? {} : { notBefore: job.notBefore }),
        ...(job.started === undefined ? {} : { started: job.started }),
        ...(job.completed === undefined ? {} : { completed: job.completed }),
        quantity: job.quantity,
        cycleEnds: job.cycles.map((cycle) => cycle.at),
      }));
      for (const { job, head, window } of jobWindows(queued, until, machine)) {
        windows.set(job.id, { head, window });
      }
    }

    // Orders: completion, in-progress time, order OEE, first-pass yield.
    const orderEntries: [string, OrderOeeJson][] = [];
    const inProgress: { orderId: string; range: Range; open: boolean }[] = [];
    const orderParts: {
      orderId: string;
      order: Order;
      completedAt: SimTime | undefined;
      range: Range | undefined;
    }[] = [];
    for (const [orderId, order] of orders) {
      const orderJobs = order.jobs.map((id) => jobs.get(id)).filter((j) => j !== undefined);
      const done =
        orderJobs.every((job) => job.completed !== undefined) &&
        order.blanks.size === orderJobs.reduce((sum, job) => sum + job.quantity, 0) &&
        [...order.blanks].every((partId) => units.get(partId)?.terminalAt !== undefined);
      const completedAt = done
        ? Math.max(...[...order.blanks].map((partId) => units.get(partId)?.terminalAt ?? 0))
        : undefined;
      const heads = orderJobs.flatMap((job) => {
        const head = windows.get(job.id)?.head;
        // A head time after the cut-off (a notBefore still ahead) doesn't start the order yet.
        return head?.kind === 'head' && head.at <= until ? [head.at] : [];
      });
      const range =
        heads.length === 0 ? undefined : { from: Math.min(...heads), to: completedAt ?? until };
      if (range) inProgress.push({ orderId, range, open: completedAt === undefined });
      orderParts.push({ orderId, order, completedAt, range });
    }
    for (const { orderId, order, completedAt, range } of orderParts) {
      const orderJobs = order.jobs.map((id) => jobs.get(id)).filter((j) => j !== undefined);
      const result = orderOee(
        {
          jobs: orderJobs.map((job) => ({
            id: job.id,
            window: windows.get(job.id)?.window,
            intervals: intervals.get(job.machine) ?? [],
            cycles: job.cycles,
            operation: this.#operation.get(job.machine) ?? this.#firstOperation,
          })),
          scheduled,
          idealCycleMs: ideal,
        },
        config.oee,
      );
      const jobOee = orderJobs.map((job): [string, JobOeeJson] => {
        const { head, window } = windows.get(job.id) ?? { head: { kind: 'waiting' } };
        const oee = result.jobs[job.id];
        return [
          job.id,
          {
            machine: job.machine,
            headTime: head.kind === 'head' ? isoTime(head.at) : null,
            headSource:
              head.kind === 'head' &&
              (head.source === 'accepted' ||
                head.source === 'previous-completed' ||
                head.source === 'notBefore')
                ? head.source
                : null,
            window:
              window === undefined
                ? null
                : { from: isoTime(window.from), to: isoTime(window.to), open: window.open },
            cycles: job.cycles.length,
            oee: oee === undefined || oee === null ? null : resultJson(oee),
          },
        ];
      });
      const fpy = firstPassYield({
        started: order.blanks.size,
        units: order.units.map((partId) => ({ records: units.get(partId)?.records ?? [] })),
        lastOperation: this.#lastOperation,
      });
      orderEntries.push([
        orderId,
        {
          product: order.product,
          jobs: [...order.jobs],
          jobOee: sortedRecord(jobOee),
          oee: resultJson(result.order),
          open: result.open,
          pending: result.pending,
          headTimeUnknown: result.headTimeUnknown,
          endLost: result.endLost,
          lost: result.lost,
          firstPassYield: {
            firstPassGood: safe(fpy.firstPassGood, 'first-pass good'),
            started: safe(fpy.started, 'started'),
            yield: ratio(fpy.yield),
          },
          completedAt: completedAt === undefined ? null : isoTime(completedAt),
          line:
            range === undefined
              ? null
              : lineValue(
                  range,
                  linePlannedBusyMs({ bucket: range, scheduled, plannedStops }),
                  order.packed,
                  effectiveCycleMs,
                  completedAt === undefined,
                ),
        },
      ]);
    }

    // Line buckets: every UTC hour and every shift bucket of the run up to the cut-off.
    const orderMode = this.#production === 'orders';
    const ranges = inProgress.map((entry) => entry.range);
    const value = (bucket: Range, provisional: boolean): LineValueJson =>
      lineValue(
        bucket,
        linePlannedBusyMs({
          bucket,
          scheduled,
          plannedStops,
          ...(orderMode ? { inProgress: ranges } : {}),
        }),
        packed.filter((p) => p.at >= bucket.from && p.at < bucket.to),
        effectiveCycleMs,
        provisional,
      );
    const hours: [string, LineValueJson][] = [];
    for (let hour = hourStart(start); hour < until; hour += HOUR) {
      const bucket = { from: Math.max(hour, start), to: Math.min(hour + HOUR, until) };
      hours.push([isoTime(hour), value(bucket, hour + HOUR > until)]);
    }
    const shifts: [string, LineValueJson][] = shiftSegments(config.shifts, start, until)
      .filter((segment) => segment.key !== NO_SHIFT)
      .map((segment) => [
        segment.key,
        value(
          { from: segment.from, to: segment.to },
          segment.to === until && shiftKeyAt(config.shifts, until) === segment.key,
        ),
      ]);

    return {
      analysisConfigSha256: this.#analysisConfigSha256,
      config: {
        productionMode: this.#production,
        microStopThresholdMs: config.oee.microStopThresholdMs,
        scheduledTime: config.oee.scheduledTime,
      },
      bottlenecks: sortedRecord(
        Object.entries(bottlenecks).map(([product, b]): [string, BottleneckJson] => [
          product,
          {
            operation: b.operation,
            equipment: [...b.equipment],
            idealCycleMs: b.idealCycleMs,
            effectiveCycleMs: formatFraction(b.effectiveCycleMs),
          },
        ]),
      ),
      plannedStops: stops.map((stop) => stop.json),
      inProgress: inProgress
        .sort((a, b) => a.range.from - b.range.from || (a.orderId < b.orderId ? -1 : 1))
        .map((entry) => ({
          orderId: entry.orderId,
          from: isoTime(entry.range.from),
          to: isoTime(entry.range.to),
          open: entry.open,
        })),
      line: { hours: Object.fromEntries(hours), shifts: Object.fromEntries(shifts) },
      orders: sortedRecord(orderEntries),
    };
  }

  #onJob(
    event: Extract<PlantEvent, { type: 'job' }>,
    jobs: Map<string, Job>,
    queues: Map<string, Job[]>,
    orders: Map<string, Order>,
    current: Map<string, Job>,
  ): void {
    if (event.transition === 'accepted') {
      const job: Job = {
        id: event.commandId,
        machine: event.machineId,
        orderId: event.orderId,
        product: event.product,
        quantity: event.quantity,
        accepted: event.at,
        notBefore: this.#notBefore.get(event.commandId),
        cycles: [],
      };
      jobs.set(job.id, job);
      queues.set(job.machine, [...(queues.get(job.machine) ?? []), job]);
      let order = orders.get(job.orderId);
      if (!order) {
        order = { product: job.product, jobs: [], blanks: new Set(), units: [], packed: [] };
        orders.set(job.orderId, order);
      }
      order.jobs.push(job.id);
      return;
    }
    const job = jobs.get(event.commandId);
    if (!job) {
      throw new RangeError(`job ${event.commandId} ${event.transition} before it was accepted`);
    }
    if (event.transition === 'started') {
      job.started = event.at;
      current.set(job.machine, job);
    } else {
      job.completed = event.at;
    }
  }
}

function lineValue(
  bucket: Range,
  plannedBusyMs: number,
  packed: readonly { product: string }[],
  effectiveCycleMs: Readonly<Record<string, Fraction>>,
  provisional: boolean,
): LineValueJson {
  const good = new Map<string, number>();
  for (const p of packed) good.set(p.product, (good.get(p.product) ?? 0) + 1);
  const result = lineOee({
    plannedBusyMs,
    good: [...good].map(([product, count]) => ({ product, count })),
    effectiveCycleMs,
  });
  return {
    from: isoTime(bucket.from),
    to: isoTime(bucket.to),
    plannedBusyMs: safe(result.plannedBusyMs, 'line planned busy time'),
    good: sortedRecord(good),
    idealMs: formatFraction(result.idealMs),
    oee: ratio(result.oee),
    aboveOne: result.aboveOne,
    provisional,
  };
}
