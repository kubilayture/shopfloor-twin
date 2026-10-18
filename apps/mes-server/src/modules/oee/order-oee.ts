/**
 * Order OEE in the MES (#231, P9-04; ADR-0036 and its P9-04 amendment): per order and per job,
 * derived on read from the other modules' interfaces with `oee-core`'s Phase 9 functions, the very
 * ones the simulator's ground truth (`line-oee.json`) uses:
 *
 * - **Queue** (`order-queue.ts`): each CNC's queue from the orders module's command state, every
 *   job whose acceptance is not refuted, in acceptance order, with `notBefore`, `quantity`, the
 *   job's OP10 cycle ends, the lost flags and the machine; `jobWindows` gives head times and
 *   windows up to the CNC's final-through (the cut-off, exclusive).
 * - **States:** the equipment module's stored pieces on the CNC, joined back into whole state
 *   intervals (a Stopped interval's whole length decides a micro-stop).
 * - **Cycles:** the job's OP10 cycles attributed by unit (ADR-0031, the execution module's units
 *   and their command); ideal time is the product's OP10 ideal cycle.
 * - **First-pass yield:** units packed good with every record good ÷ blanks taken (units plus
 *   blanks still in a CNC); **completion** is the execution module's ADR-0031 completion.
 *
 * **Finality** (ADR-0018, ADR-0031): an order's OEE is final only when every input is final through
 * its windows and no further job can come: at least one job, every command of the order settled
 * and the order fully dispatched (or complete, closed or cancelled), no lost fact, every window
 * closed with a known head time, every command dispatched earlier to the same CNC settled, the
 * CNC's pieces covering each window and none of them provisional, exactly `quantity` OP10 cycles
 * attributed to each job inside its window, and the execution module having processed the CNC
 * through the window's end. The first-pass yield is final once the order is complete. A final
 * result never changes, so it is kept in memory (derive and cache; nothing is stored, ADR-0022).
 */
import {
  firstPassYield,
  jobWindows,
  normalize,
  orderOee,
  type FirstPassYield,
  type HeadTime,
  type JobWindow,
  type Millis,
  type OeeConfig,
  type OeeResult,
  type OrderOeeResult,
  type QueuedJob,
  type Range,
  type TimedCycleCount,
  type TimelineInterval,
} from '@shopfloor/oee-core';
import { NO_SHIFT, shiftSegments, type ShiftPattern } from '@shopfloor/shift-calendar';
import type { Equipment, StoredInterval } from '../equipment/index.ts';
import type { Execution, UnitRecord } from '../execution/index.ts';
import type { Ingest } from '../ingest/index.ts';
import type { MasterData } from '../master-data/index.ts';
import type { CommandRecord, OrderRecord, Orders } from '../orders/index.ts';
import {
  commandQueues,
  orderSlice,
  queuedJob,
  type CommandQueue,
  type DeviceCut,
  type QueueCommand,
} from './order-queue.ts';

/** What order OEE reads from the other modules (their `index.ts` interfaces). */
export interface OrderOeeSources {
  readonly orders: Pick<Orders, 'order' | 'commands' | 'onChange'>;
  readonly execution: Pick<Execution, 'units' | 'orderExecution' | 'processedThrough' | 'onChange'>;
  readonly equipment: Pick<Equipment, 'intervals' | 'onPiecesChanged'>;
  readonly ingest: Pick<Ingest, 'deviceProgress'>;
  readonly masterData: Pick<MasterData, 'equipment'>;
}

export interface OrderOeeOptions extends OrderOeeSources {
  readonly shiftPattern: ShiftPattern;
  /** `config/plant/oee.yaml`. */
  readonly config: OeeConfig;
  /** Ideal cycle ms per product and operation (plant-config `idealCycleMs`). */
  readonly idealCycleMs: Readonly<Record<string, Readonly<Record<string, Millis>>>>;
  /** The routing's operations in order (`products.yaml`): OP10 first, the packing one last. */
  readonly operations: readonly string[];
}

/** One job of an order with its head time, window and OEE. */
export interface OrderJobView {
  readonly commandId: string;
  readonly machine: string;
  readonly deviceEpoch: number;
  readonly quantity: number;
  readonly notBefore: Date;
  readonly head: HeadTime;
  readonly window: JobWindow | undefined;
  /** OP10 cycles attributed to the job (by unit). */
  readonly cycles: number;
  readonly result: OeeResult | null;
  readonly final: boolean;
}

/** An order's OEE, its jobs and its first-pass yield (`GET /oee/orders/{id}`, `oee:order:<id>`). */
export interface OrderOeeView {
  readonly orderId: string;
  readonly product: string;
  readonly status: string;
  /** `oee-core`'s `orderOee`: the order result and the flags. */
  readonly result: OrderOeeResult;
  readonly jobs: readonly OrderJobView[];
  readonly firstPassYield: FirstPassYield & { readonly final: boolean };
  readonly completedAt: Date | null;
  /** The order OEE and every job are final (module comment); the yield has its own. */
  readonly final: boolean;
  /** Each CNC queue's cut-off (final-through); null before the CNC has a settled fact. */
  readonly cutoffs: readonly { machine: string; epoch: number; at: Date | null }[];
}

const queueCommand = (c: CommandRecord): QueueCommand => ({
  commandId: c.commandId,
  orderId: c.orderId,
  equipment: c.equipment,
  deviceEpoch: c.deviceEpoch,
  quantity: c.quantity,
  notBefore: c.notBefore.getTime(),
  queuePosition: c.queuePosition,
  settled: c.settled,
  acceptedBy: c.acceptedBy,
  acceptedSeq: c.acceptedSeq,
  acceptedAt: c.acceptedAt?.getTime() ?? null,
  jobLost: c.job === 'lost',
  startedAt: c.startedAt?.getTime() ?? null,
  completedAt: c.completedAt?.getTime() ?? null,
});

/**
 * Stored pieces (each inside one hour and shift bucket) joined back into whole state intervals:
 * pieces of one interval share its start. `open` while a piece of it may still change.
 */
export function wholeIntervals(pieces: readonly StoredInterval[]): TimelineInterval[] {
  const byStart = new Map<
    number,
    { from: number; to: number; state: string; cause: string | null; open: boolean }
  >();
  for (const piece of pieces) {
    const start = piece.intervalStart.getTime();
    const found = byStart.get(start);
    const end = piece.end.getTime();
    if (found) {
      found.to = Math.max(found.to, end);
      found.open ||= piece.provisional;
    } else {
      byStart.set(start, {
        from: start,
        to: end,
        state: piece.state,
        cause: piece.cause,
        open: piece.provisional,
      });
    }
  }
  return [...byStart.values()]
    .sort((a, b) => a.from - b.from)
    .map(({ open, ...interval }) => ({
      ...(interval as TimelineInterval),
      ...(open ? { open: true } : {}),
    }));
}

/** Whether the pieces cover `window` completely, none of them provisional. */
export function piecesFinal(pieces: readonly StoredInterval[], window: Range): boolean {
  let covered = 0;
  for (const piece of pieces) {
    const from = Math.max(piece.start.getTime(), window.from);
    const to = Math.min(piece.end.getTime(), window.to);
    if (to <= from) continue;
    if (piece.provisional) return false;
    covered += to - from;
  }
  return covered === window.to - window.from;
}

export class OrderOee {
  readonly #options: OrderOeeOptions;
  readonly #listeners = new Set<(orderId: string | null) => void>();
  /** Final views never change (ADR-0018): kept so a final order costs nothing to read again. */
  readonly #finals = new Map<string, OrderOeeView>();
  #operations: Map<string, string> | undefined;
  #detach: (() => void)[] = [];

  constructor(options: OrderOeeOptions) {
    this.#options = options;
  }

  /** Follows the changes order OEE is computed from (for push). */
  start(): void {
    const { orders, execution, equipment } = this.#options;
    this.#detach.push(
      orders.onChange((change) => {
        if (change.type === 'command') this.#emit(null);
        else if (change.type === 'order') this.#emit(change.order.id);
      }),
      execution.onChange((change) => {
        if (change.type === 'order') this.#emit(change.orderId);
      }),
      equipment.onPiecesChanged(() => {
        this.#emit(null);
      }),
    );
  }

  stop(): void {
    for (const detach of this.#detach.splice(0)) detach();
  }

  /**
   * Listens for changes that may move an order's OEE: an order id, or null when any order may
   * have moved (a command or a CNC's states: other orders on the CNC decide head times). The
   * listener runs synchronously inside the modules' notices: it must only record what changed.
   */
  onChange(listener: (orderId: string | null) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(orderId: string | null): void {
    for (const listener of this.#listeners) {
      try {
        listener(orderId);
      } catch {
        // A listener's failure must not reach the notifying module.
      }
    }
  }

  async #operationOf(machine: string): Promise<string> {
    this.#operations ??= new Map(
      (await this.#options.masterData.equipment()).map((e) => [e.id, e.operation]),
    );
    return this.#operations.get(machine) ?? this.#options.operations[0] ?? 'OP10';
  }

  /** The order's OEE, jobs and first-pass yield; undefined when the order doesn't exist. */
  async order(orderId: string): Promise<OrderOeeView | undefined> {
    const cached = this.#finals.get(orderId);
    if (cached) return cached;
    const order = await this.#options.orders.order(orderId);
    if (!order) return undefined;
    const view = await this.#compute(order);
    if (view.final && view.firstPassYield.final) this.#finals.set(orderId, view);
    return view;
  }

  async #compute(order: OrderRecord): Promise<OrderOeeView> {
    const { orders, execution, ingest, equipment, config } = this.#options;
    const first = this.#options.operations[0] ?? 'OP10';
    const last = this.#options.operations.at(-1) ?? 'OP50';
    // Every command (other orders' jobs on the same CNC decide head times), and the CNCs' cuts.
    const all = (await orders.commands()).map(queueCommand);
    const mine = all.filter((c) => c.orderId === order.id);
    const machines = [...new Set(mine.map((c) => c.equipment))].sort();
    const cuts = new Map<string, DeviceCut>();
    for (const machine of machines) {
      const progress = await ingest.deviceProgress(machine);
      cuts.set(machine, {
        epoch: progress.epoch,
        finalThrough: progress.settledTime?.getTime() ?? null,
      });
    }
    const queues = commandQueues(
      all.filter((c) => machines.includes(c.equipment)),
      cuts,
    ).filter((q) => q.commands.some((c) => c.orderId === order.id));
    // Units of the orders in each slice: the order's own (cycles, first-pass yield) and its
    // neighbours' (a lost `completed` fact recovered from the last cycle; a lost end).
    const slices = queues.map((queue) => ({ queue, ...orderSlice(queue, order.id) }));
    const orderIds = new Set<string>([order.id]);
    for (const { queue, from, to } of slices) {
      for (const c of queue.commands.slice(from, to)) orderIds.add(c.orderId);
    }
    const unitsOf = new Map<string, UnitRecord[]>();
    for (const id of [...orderIds].sort()) {
      unitsOf.set(id, (await execution.units({ orderId: id, limit: 1_000_000 })).units);
    }
    const cyclesOf = new Map<string, TimedCycleCount[]>();
    for (const units of unitsOf.values()) {
      for (const unit of units) {
        if (unit.commandId === null) continue;
        const record = unit.records.find((r) => r.operation === first);
        if (!record) continue;
        const list = cyclesOf.get(unit.commandId) ?? [];
        list.push({
          at: record.at.getTime(),
          product: unit.product,
          result: record.result,
          count: 1,
        });
        cyclesOf.set(unit.commandId, list);
      }
    }
    for (const list of cyclesOf.values()) list.sort((a, b) => a.at - b.at);

    // Head times and windows per queue slice.
    const jobs: {
      command: QueueCommand;
      queue: CommandQueue;
      job: QueuedJob;
      head: HeadTime;
      window: JobWindow | undefined;
    }[] = [];
    for (const { queue, from, to } of slices) {
      const cut = cuts.get(queue.machine);
      const slice = queue.commands.slice(from, to).map((_, k) =>
        queuedJob(
          queue,
          from + k,
          cut,
          (cyclesOf.get(queue.commands[from + k]?.commandId ?? '') ?? []).map((c) => c.at),
        ),
      );
      for (const [k, { job, head, window }] of jobWindows(
        slice,
        queue.until,
        queue.machine,
      ).entries()) {
        const command = queue.commands[from + k];
        if (command?.orderId === order.id) jobs.push({ command, queue, job, head, window });
      }
    }

    // State intervals inside each window (whole, see `wholeIntervals`), and the scheduled time.
    const threshold = config.microStopThresholdMs;
    const views: {
      entry: (typeof jobs)[number];
      intervals: TimelineInterval[];
      piecesFinal: boolean;
      operation: string;
    }[] = [];
    let span: Range | undefined;
    for (const entry of jobs) {
      const window = entry.window;
      let intervals: TimelineInterval[] = [];
      let final = false;
      if (window) {
        const pieces = await equipment.intervals(
          entry.queue.machine,
          new Date(window.from),
          new Date(window.to + threshold),
          { epoch: entry.queue.epoch },
        );
        intervals = wholeIntervals(pieces);
        final = piecesFinal(pieces, window);
        span = {
          from: Math.min(span?.from ?? window.from, window.from),
          to: Math.max(span?.to ?? window.to, window.to),
        };
      }
      views.push({
        entry,
        intervals,
        piecesFinal: final,
        operation: await this.#operationOf(entry.queue.machine),
      });
    }
    // One ms past the last window: a job's last cycle ends at its completion, the window's end,
    // and is scheduled when that instant is (as the truth's calendar over the whole run says).
    const scheduled: Range[] =
      span === undefined
        ? []
        : normalize(
            shiftSegments(this.#options.shiftPattern, span.from, span.to + 1)
              .filter((segment) => segment.key !== NO_SHIFT)
              .map(({ from, to }) => ({ from, to })),
          );
    const result = orderOee(
      {
        jobs: views.map(({ entry, intervals, operation }) => ({
          id: entry.command.commandId,
          window: entry.window,
          intervals,
          cycles: cyclesOf.get(entry.command.commandId) ?? [],
          operation,
        })),
        scheduled,
        idealCycleMs: this.#options.idealCycleMs,
      },
      config,
    );

    // Finality (module comment).
    const processed = execution.processedThrough();
    const settledBefore = (command: QueueCommand, queue: CommandQueue): boolean =>
      all.every(
        (c) =>
          c.equipment !== queue.machine ||
          c.deviceEpoch !== queue.epoch ||
          c.queuePosition >= command.queuePosition ||
          c.settled,
      );
    const jobViews: OrderJobView[] = views.map(({ entry, piecesFinal: covered }) => {
      const { command, queue, window } = entry;
      const cycles = cyclesOf.get(command.commandId) ?? [];
      const jobResult = result.jobs[command.commandId] ?? null;
      const progress = processed.get(queue.machine);
      const final =
        window !== undefined &&
        jobResult !== null &&
        !jobResult.provisional &&
        !window.open &&
        !window.headTimeUnknown &&
        !window.endLost &&
        !window.lost &&
        command.settled &&
        settledBefore(command, queue) &&
        covered &&
        cycles.length === command.quantity &&
        cycles.every((c) => c.at >= window.from && c.at <= window.to) &&
        progress?.epoch === queue.epoch &&
        progress.settledTime !== null &&
        progress.settledTime.getTime() >= window.to;
      return {
        commandId: command.commandId,
        machine: queue.machine,
        deviceEpoch: queue.epoch,
        quantity: command.quantity,
        notBefore: new Date(command.notBefore),
        head: entry.head,
        window,
        cycles: cycles.length,
        result: jobResult,
        final,
      };
    });
    const noMoreJobs =
      (order.dispatched >= order.quantity && order.inFlight === 0 && !order.dispatchFailed) ||
      order.status === 'completed' ||
      order.status === 'closed' ||
      order.status === 'cancelled';
    const oeeFinal =
      jobViews.length > 0 &&
      jobViews.every((job) => job.final) &&
      mine.every((c) => c.settled) &&
      !order.dispatchLost &&
      noMoreJobs &&
      !result.order.provisional &&
      !result.lost;

    // First-pass yield across the routing, and the order's completion.
    const own = unitsOf.get(order.id) ?? [];
    const executed = await execution.orderExecution(order.id);
    const inMachine = Object.values(executed?.inMachine ?? {}).reduce((sum, n) => sum + n, 0);
    const fpy = firstPassYield({
      started: own.length + inMachine,
      units: own.map((unit) => ({
        records: unit.records.map((r) => ({ operation: r.operation, result: r.result })),
      })),
      lastOperation: last,
    });
    const completedAt = executed?.completedAt ?? null;
    return {
      orderId: order.id,
      product: order.product,
      status: order.status,
      result,
      jobs: jobViews,
      firstPassYield: { ...fpy, final: completedAt !== null },
      completedAt,
      final: oeeFinal,
      cutoffs: queues
        .map((q) => ({
          machine: q.machine,
          epoch: q.epoch,
          at: q.until > 0 ? new Date(q.until) : null,
        }))
        .sort((a, b) =>
          a.machine < b.machine ? -1 : a.machine > b.machine ? 1 : a.epoch - b.epoch,
        ),
    };
  }
}
