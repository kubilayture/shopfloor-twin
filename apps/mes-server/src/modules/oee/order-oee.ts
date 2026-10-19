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
 * through the window's end (in its own run, or the execution module already in a newer run), no
 * interval overlapping a window still open, and no `unknown-job` incident open on the CNC. The
 * first-pass yield is final once the order is complete.
 *
 * **Written-off gaps** (ADR-0018): the sequence-gap incidents overlapping the order's windows on its
 * CNCs, or the span of its units on any machine they visited, are listed on the view (`incidents`):
 * a value final over a written-off gap carries the marker, as the OEE buckets do, and may still be
 * revised if the facts arrive after all. A final view without incidents never changes, so its
 * immutable part is kept in memory (derive and cache; nothing is stored, ADR-0022); a view with
 * incidents is never cached. A cached view's status and cut-offs are read again on every hit.
 * Gaps are looked up in each machine's own device epoch (#232: WSH-01's stream has its own); a view
 * with incidents carries `mayRevise` and the `revision` of the hours under it.
 *
 * **Line OEE** (#232, ADR-0036 P9-05 amendment): the view carries the order's own line OEE over
 * its in-progress time (`line`), and `lineOrders()` gives every order's in-progress start and
 * completion and how far each CNC's jobs are known, for the line buckets (`line-oee.ts`). A view is
 * kept in memory only once its line value is final too.
 */
import {
  firstPassYield,
  jobWindows,
  normalize,
  orderOee,
  type FirstPassYield,
  type HeadTime,
  type HeadUnknownReason,
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
  calendar,
  gapTouches,
  lineModel,
  lineValue,
  maintenance,
  type LineModel,
  type LineValue,
} from './line-inputs.ts';
import {
  commandQueues,
  inQueue,
  orderSlice,
  queuedJob,
  type CommandQueue,
  type DeviceCut,
  type QueueCommand,
} from './order-queue.ts';

/** What order OEE reads from the other modules (their `index.ts` interfaces). */
export interface OrderOeeSources {
  readonly orders: Pick<Orders, 'order' | 'list' | 'commands' | 'incidents' | 'onChange'>;
  readonly execution: Pick<Execution, 'units' | 'orderExecution' | 'processedThrough' | 'onChange'>;
  readonly equipment: Pick<Equipment, 'intervals' | 'revision' | 'onPiecesChanged' | 'watermarks'>;
  readonly ingest: Pick<Ingest, 'deviceProgress' | 'settled'>;
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
  /**
   * Sequence-gap incidents (written-off gaps, ADR-0018) overlapping the order's windows on its
   * CNCs or its units' span on the machines they visited (each machine in its own device epoch):
   * values over them may be revised.
   */
  readonly incidents: readonly OrderGapIncident[];
  /** The view carries `incidents`: even a final value may still be revised (#232). */
  readonly mayRevise: boolean;
  /**
   * How often a final hour under the view changed after it was final (the highest revision of the
   * machines' hours over its spans, ADR-0018), read while the view carries incidents, else 0: a
   * revised final has a higher number than the one it replaces (#232).
   */
  readonly revision: number;
  /**
   * The order's line throughput OEE (#232, ADR-0036): over its in-progress time, from the earliest
   * head time of its jobs to its completion (or the cut-off while open), with its own good packed
   * units; not additive across orders. Null before a job is head.
   */
  readonly line: OrderLineView | null;
}

/** An order's line OEE (`OrderOeeView.line`). */
export interface OrderLineView {
  readonly value: LineValue;
  /** The order is not complete: its in-progress time runs to the cut-off. */
  readonly open: boolean;
  /**
   * The order OEE is final, the order complete and the bottleneck's pieces final over the range
   * (its Maintenance, a planned stop).
   */
  readonly final: boolean;
}

/**
 * A job without a known head time, for line OEE's finality (`OrderOee.lineOrders`): its head time,
 * once known, is at or after its `notBefore`; a `waiting` job's is also at or after its
 * predecessor's completion, so while that predecessor's order is open its own in-progress time
 * covers the job's up to the cut-off.
 */
export interface UnknownHead {
  readonly orderId: string;
  readonly commandId: string;
  readonly machine: string;
  readonly notBefore: Millis;
  readonly reason: HeadUnknownReason | 'waiting';
  /** For `waiting`: the order of the job before it on the CNC. */
  readonly after: string | null;
}

/** Every order's in-progress start and completion (`OrderOee.lineOrders`, #232). */
export interface LineOrders {
  readonly orders: readonly {
    readonly orderId: string;
    /** The earliest head time of its jobs at or before their CNC's cut-off; null: not started. */
    readonly from: Millis | null;
    /** ADR-0031 completion (the orders module's record of it); null while open. */
    readonly completedAt: Millis | null;
    readonly unknown: readonly UnknownHead[];
  }[];
  /** CNCs with an open `unknown-job` incident (the queue may miss a job). */
  readonly unknownJob: ReadonlySet<string>;
  /**
   * Per CNC with a queue in its current run, how far its facts are known for line OEE: its job
   * facts and OP10 cycles are the only facts of a CNC line OEE reads, so the CNC holds the line's
   * final-through back only while a job of it can still bring one: its final-through while a job
   * runs (or its head time is unknown), the later of that and a job's head time while the job is
   * accepted and waits to start (a `notBefore` ahead), and nothing (Infinity) once every job of its
   * queue is completed. A CNC without a queue in its current run holds nothing back either: a job
   * dispatched to it later is accepted after the plant clock.
   */
  readonly cncThrough: ReadonlyMap<string, Millis>;
}

/** One sequence-gap incident an order's inputs touch. */
export interface OrderGapIncident {
  readonly machine: string;
  readonly epoch: number;
  readonly id: number;
  readonly seqFrom: number;
  readonly seqTo: number;
}

/**
 * What changed for order OEE: one order (`orderId`), the orders with a job on one CNC (`machine`:
 * its states, or a command to it; other orders on a CNC decide head times), or, with neither,
 * any order.
 */
export interface OrderOeeChange {
  readonly orderId?: string;
  readonly machine?: string;
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
  readonly #listeners = new Set<(change: OrderOeeChange) => void>();
  /** Final views never change (ADR-0018): kept so a final order costs nothing to read again. */
  readonly #finals = new Map<string, OrderOeeView>();
  #operations: Map<string, string> | undefined;
  #model: LineModel | undefined;
  #detach: (() => void)[] = [];

  constructor(options: OrderOeeOptions) {
    this.#options = options;
  }

  /** Follows the changes order OEE is computed from (for push). */
  start(): void {
    const { orders, execution, equipment } = this.#options;
    this.#detach.push(
      orders.onChange((change) => {
        if (change.type === 'command') {
          this.#emit({ machine: change.command.equipment });
          this.#emit({ orderId: change.command.orderId });
        } else if (change.type === 'order') this.#emit({ orderId: change.order.id });
      }),
      execution.onChange((change) => {
        if (change.type === 'order') this.#emit({ orderId: change.orderId });
      }),
      equipment.onPiecesChanged((change) => {
        this.#emit({ machine: change.equipment });
      }),
    );
  }

  stop(): void {
    for (const detach of this.#detach.splice(0)) detach();
  }

  /**
   * Listens for changes that may move an order's OEE (`OrderOeeChange`). The listener runs
   * synchronously inside the modules' notices: it must only record what changed.
   */
  onChange(listener: (change: OrderOeeChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(change: OrderOeeChange): void {
    for (const listener of this.#listeners) {
      try {
        listener(change);
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

  /** The line's machines and its designed bottleneck (`deriveBottlenecks`), from master data. */
  async lineModel(): Promise<LineModel> {
    this.#model ??= lineModel(
      await this.#options.masterData.equipment(),
      this.#options.operations,
      this.#options.idealCycleMs,
    );
    return this.#model;
  }

  /** The units of the orders, and their OP10 cycles per command (ADR-0031), by time. */
  async #unitsAndCycles(orderIds: Iterable<string>): Promise<{
    unitsOf: Map<string, UnitRecord[]>;
    cyclesOf: Map<string, TimedCycleCount[]>;
  }> {
    const first = this.#options.operations[0] ?? 'OP10';
    const unitsOf = new Map<string, UnitRecord[]>();
    for (const id of [...new Set(orderIds)].sort()) {
      unitsOf.set(
        id,
        (await this.#options.execution.units({ orderId: id, limit: 1_000_000 })).units,
      );
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
    return { unitsOf, cyclesOf };
  }

  /**
   * Every order's in-progress start and completion for line OEE (#232, ADR-0036): each CNC's whole
   * queue (as `order` builds it) gives head times; an order starts at the earliest head time of its
   * jobs at or before their CNC's cut-off (a head time after it, a `notBefore` still ahead, starts
   * nothing) and runs to its ADR-0031 completion. Jobs whose head time is unknown are listed (they
   * keep the line buckets they may touch provisional). Cycle ends are read only for the orders with
   * a job not completed yet: only a lost completion is recovered from them.
   */
  async lineOrders(): Promise<LineOrders> {
    const { orders, ingest } = this.#options;
    const all = (await orders.commands()).map(queueCommand);
    const cuts = new Map<string, DeviceCut>();
    for (const machine of [...new Set(all.map((c) => c.equipment))].sort()) {
      const progress = await ingest.deviceProgress(machine);
      cuts.set(machine, {
        epoch: progress.epoch,
        finalThrough: progress.settledTime?.getTime() ?? null,
      });
    }
    const queues = commandQueues(all, cuts);
    const needed = new Set(
      all
        .filter(
          (c) =>
            inQueue(c) &&
            c.completedAt === null &&
            (c.acceptedBy !== null || c.startedAt !== null || c.jobLost),
        )
        .map((c) => c.orderId),
    );
    const { cyclesOf } = await this.#unitsAndCycles(needed);
    const byOrder = new Map<string, { heads: Millis[]; unknown: UnknownHead[] }>();
    const entry = (orderId: string) => {
      let found = byOrder.get(orderId);
      if (!found) {
        found = { heads: [], unknown: [] };
        byOrder.set(orderId, found);
      }
      return found;
    };
    const cncThrough = new Map<string, Millis>();
    for (const queue of queues) {
      const cut = cuts.get(queue.machine);
      const current = cut?.epoch === queue.epoch;
      const through = cut?.finalThrough ?? Number.NEGATIVE_INFINITY;
      if (current && !cncThrough.has(queue.machine)) {
        cncThrough.set(queue.machine, Number.POSITIVE_INFINITY);
      }
      const jobs = queue.commands.map((c, i) =>
        queuedJob(
          queue,
          i,
          cut,
          needed.has(c.orderId) ? (cyclesOf.get(c.commandId) ?? []).map((x) => x.at) : undefined,
        ),
      );
      for (const [i, { head }] of jobWindows(jobs, queue.until, queue.machine).entries()) {
        const command = queue.commands[i];
        if (!command) continue;
        if (current && command.completedAt === null) {
          const holds =
            command.startedAt === null && head.kind === 'head'
              ? Math.max(through, head.at)
              : through;
          cncThrough.set(
            queue.machine,
            Math.min(cncThrough.get(queue.machine) ?? Number.POSITIVE_INFINITY, holds),
          );
        }
        const found = entry(command.orderId);
        if (head.kind === 'head') {
          // A head time after the CNC's cut-off (a `notBefore` ahead) starts nothing yet.
          if (head.at <= queue.until) found.heads.push(head.at);
        } else {
          found.unknown.push({
            orderId: command.orderId,
            commandId: command.commandId,
            machine: queue.machine,
            notBefore: command.notBefore,
            reason: head.kind === 'waiting' ? 'waiting' : head.reason,
            after: head.kind === 'waiting' ? (queue.commands[i - 1]?.orderId ?? null) : null,
          });
        }
      }
    }
    const completion = new Map<string, Millis | null>();
    if (byOrder.size > 0) {
      for (const order of (await orders.list({ limit: 1_000_000 })).orders) {
        completion.set(order.id, order.completedAt?.getTime() ?? null);
      }
    }
    const unknownJob = new Set(
      (await orders.incidents({ open: true }))
        .filter((incident) => incident.type === 'unknown-job' && incident.equipment !== null)
        .map((incident) => incident.equipment ?? ''),
    );
    return {
      orders: [...byOrder]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([orderId, found]) => ({
          orderId,
          from: found.heads.length === 0 ? null : Math.min(...found.heads),
          completedAt: completion.get(orderId) ?? null,
          unknown: found.unknown,
        })),
      unknownJob,
      cncThrough,
    };
  }

  /** The order's OEE, jobs and first-pass yield; undefined when the order doesn't exist. */
  async order(orderId: string): Promise<OrderOeeView | undefined> {
    const order = await this.#options.orders.order(orderId);
    if (!order) return undefined;
    const cached = this.#finals.get(orderId);
    if (cached) return { ...cached, status: order.status, cutoffs: await this.#cutoffs(cached) };
    const view = await this.#compute(order);
    // Kept only once everything in it is final: the order OEE, the yield and its line OEE (#232).
    if (
      view.final &&
      view.firstPassYield.final &&
      view.line?.final === true &&
      view.incidents.length === 0
    ) {
      this.#finals.set(orderId, view);
    }
    return view;
  }

  /** A cached view's cut-offs now: a queue of the CNC's current run moves with its final-through. */
  async #cutoffs(view: OrderOeeView): Promise<OrderOeeView['cutoffs']> {
    const result = [];
    for (const cut of view.cutoffs) {
      const progress = await this.#options.ingest.deviceProgress(cut.machine);
      result.push(
        progress.epoch === cut.epoch && progress.settledTime !== null
          ? { ...cut, at: progress.settledTime }
          : cut,
      );
    }
    return result;
  }

  async #compute(order: OrderRecord): Promise<OrderOeeView> {
    const { orders, execution, ingest, equipment, config } = this.#options;
    const last = this.#options.operations.at(-1) ?? 'OP50';
    // Every command (other orders' jobs on the same CNC decide head times), and the CNCs' cuts.
    const records = await orders.commands();
    const all = records.map(queueCommand);
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
    const { unitsOf, cyclesOf } = await this.#unitsAndCycles(orderIds);

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
    const unknownJob = new Set(
      (await orders.incidents({ open: true }))
        .filter((incident) => incident.type === 'unknown-job' && incident.equipment !== null)
        .map((incident) => incident.equipment ?? ''),
    );
    const jobViews: OrderJobView[] = views.map(({ entry, piecesFinal: covered, intervals }) => {
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
        // Defensive: an accepted command is settled (ADR-0029), and one without an acceptance has
        // a lost or unknown head time already; kept so a reading defect can't make a job final.
        command.settled &&
        settledBefore(command, queue) &&
        covered &&
        cycles.length === command.quantity &&
        cycles.every((c) => c.at >= window.from && c.at <= window.to) &&
        processedThrough(progress, queue, window.to) &&
        !intervals.some((i) => i.open === true && i.from < window.to && i.to > window.from) &&
        !unknownJob.has(queue.machine);
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
    // The order's jobs in acceptance order across its CNCs, as the truth lists them (the
    // acceptance time; dispatch order on a tie or while unknown).
    const position = new Map(jobs.map((j) => [j.command.commandId, j.command]));
    jobViews.sort((a, b) =>
      acceptanceCompare(position.get(a.commandId), position.get(b.commandId)),
    );
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
    // A blank a CNC held when its run ended belongs to a lost job: `inMachine` no longer counts it,
    // the orders module's count of the lost job's blanks (from these units, ADR-0031) does.
    let heldAtRunEnd = 0;
    for (const command of records) {
      if (command.orderId !== order.id || command.job !== 'lost' || command.lostStarted === null) {
        continue;
      }
      const machined = own.filter((unit) => unit.commandId === command.commandId).length;
      heldAtRunEnd += Math.max(0, command.lostStarted - machined);
    }
    const fpy = firstPassYield({
      started: own.length + inMachine + heldAtRunEnd,
      units: own.map((unit) => ({
        records: unit.records.map((r) => ({ operation: r.operation, result: r.result })),
      })),
      lastOperation: last,
    });
    const completedAt = executed?.completedAt ?? null;

    // Written-off gaps the inputs touch: the windows on the CNCs (in the queue's epoch), and on
    // every machine the order's units visited, the span from their first record to the completion
    // (or their last record), in that machine's own device epoch (#232: WSH-01's stream, followed
    // by part id, has its own epoch; the unit's epoch is the CNC run's), else the unit's.
    const spans = new Map<string, { machine: string; epoch: number; from: number; to: number }>();
    const touch = (machine: string, epoch: number, from: number, to: number) => {
      const key = `${machine}\u0000${String(epoch)}`;
      const found = spans.get(key);
      spans.set(key, {
        machine,
        epoch,
        from: Math.min(found?.from ?? from, from),
        to: Math.max(found?.to ?? to, to),
      });
    };
    for (const { entry } of views) {
      if (entry.window) {
        touch(entry.queue.machine, entry.queue.epoch, entry.window.from, entry.window.to);
      }
    }
    const times = own.flatMap((unit) => unit.records.map((r) => r.at.getTime()));
    if (times.length > 0) {
      const from = times.reduce((a, b) => Math.min(a, b));
      const to = times.reduce((a, b) => Math.max(a, b), completedAt?.getTime() ?? 0);
      const epochOf = new Map<string, number | null>();
      for (const unit of own) {
        for (const record of unit.records) {
          if (!epochOf.has(record.equipment)) {
            epochOf.set(
              record.equipment,
              cuts.get(record.equipment)?.epoch ??
                (await ingest.deviceProgress(record.equipment)).epoch,
            );
          }
          touch(record.equipment, epochOf.get(record.equipment) ?? unit.epoch, from, to);
        }
      }
    }
    const incidents: OrderGapIncident[] = [];
    const ordered = [...spans.values()].sort((a, b) =>
      a.machine < b.machine ? -1 : a.machine > b.machine ? 1 : a.epoch - b.epoch,
    );
    let revision = 0;
    for (const span of ordered) {
      const settled = await ingest.settled(span.machine, span.epoch);
      for (const gap of settled.incidents) {
        if (gapTouches(gap, span.from, span.to)) {
          incidents.push({
            machine: span.machine,
            epoch: span.epoch,
            id: gap.id,
            seqFrom: gap.seqFrom,
            seqTo: gap.seqTo,
          });
        }
      }
    }
    if (incidents.length > 0) {
      for (const span of ordered) {
        revision = Math.max(
          revision,
          await equipment.revision(
            span.machine,
            span.epoch,
            new Date(span.from),
            new Date(span.to + 1),
          ),
        );
      }
    }

    // The order's line OEE (#232, ADR-0036): over its in-progress time, from the earliest head
    // time of its jobs at or before their CNC's cut-off (a head time after it starts nothing) to its
    // completion, or to the cut-off while open; its own good packed units (every one, as the truth
    // counts them); planned stops are the breaks and the bottleneck's Maintenance. Not additive.
    let line: OrderLineView | null = null;
    const heads = jobs.flatMap(({ head, queue }) =>
      head.kind === 'head' && head.at <= queue.until ? [head.at] : [],
    );
    if (heads.length > 0) {
      const model = await this.lineModel();
      const from = Math.min(...heads);
      // Open: to the plant clock (the truth's snapshot), else the CNCs' cut-offs.
      const clock =
        equipment.watermarks()[0]?.watermark.getTime() ?? Math.max(...queues.map((q) => q.until));
      const until = Math.max(from, clock);
      const range = { from, to: completedAt?.getTime() ?? until };
      const { scheduled: planned, breaks } = calendar(this.#options.shiftPattern, range);
      const stops: Range[] = [...breaks];
      let stopsFinal = true;
      // Every piece only when the value can be final (their coverage decides it); else only the
      // Maintenance pieces, the planned stops (a long order spans many hours of pieces).
      const candidate = oeeFinal && completedAt !== null;
      for (const machine of model.bottleneckMachines) {
        const pieces = await equipment.intervals(
          machine,
          new Date(range.from),
          new Date(range.to),
          candidate ? {} : { state: 'Maintenance' },
        );
        stops.push(...maintenance(pieces));
        stopsFinal &&= candidate && piecesFinal(pieces, range);
      }
      const value = lineValue({
        bucket: range,
        cut: range.to,
        scheduled: planned,
        plannedStops: stops,
        packs: own.flatMap((unit) =>
          unit.records
            .filter((r) => r.operation === last && r.result === 'good')
            .map((r) => ({ at: r.at.getTime(), product: unit.product })),
        ),
        packsInRange: false,
        effectiveCycleMs: model.effectiveCycleMs,
      });
      line = {
        value,
        open: completedAt === null,
        final: oeeFinal && completedAt !== null && stopsFinal,
      };
    }
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
      incidents,
      mayRevise: incidents.length > 0,
      revision,
      line,
    };
  }
}

/**
 * The order of an order's jobs across its CNCs (#231): acceptance time, unknown last, then
 * dispatch order (`queuePosition`), as the truth lists them.
 */
export function acceptanceCompare(
  a: Pick<QueueCommand, 'acceptedAt' | 'queuePosition'> | undefined,
  b: Pick<QueueCommand, 'acceptedAt' | 'queuePosition'> | undefined,
): number {
  const ta = a?.acceptedAt ?? Number.POSITIVE_INFINITY;
  const tb = b?.acceptedAt ?? Number.POSITIVE_INFINITY;
  return ta !== tb ? (ta < tb ? -1 : 1) : (a?.queuePosition ?? 0) - (b?.queuePosition ?? 0);
}

/**
 * Whether the execution module has processed the CNC through `to` for this queue's run: in the
 * same run, its last round's final-through is at or past `to`; a queue of an earlier run counts as
 * processed once execution is in a newer run (that run's facts all came before the newer one's).
 */
export function processedThrough(
  progress: { readonly epoch: number | null; readonly settledTime: Date | null } | undefined,
  queue: { readonly epoch: number },
  to: number,
): boolean {
  if (progress?.epoch === undefined || progress.epoch === null) return false;
  if (progress.epoch > queue.epoch) return true;
  return (
    progress.epoch === queue.epoch &&
    progress.settledTime !== null &&
    progress.settledTime.getTime() >= to
  );
}
