/**
 * Line throughput OEE in the MES (#232, P9-05; ADR-0036 and its amendments): per UTC hour and per
 * shift bucket for Line A1, derived on read with `oee-core`'s `lineOee` and `linePlannedBusyMs`,
 * the functions the simulator's ground truth (`line-oee.json`) uses, under the same conventions
 * (`line-inputs.ts`):
 *
 * - good packed at the last operation's machines (PCK-01, from its stored cycle facts) × the
 *   designed bottleneck's effective cycle per product (`deriveBottlenecks`) ÷ planned busy time;
 * - planned busy time: the shift buckets minus the calendar's breaks and the bottleneck machines'
 *   Maintenance intervals (their stored pieces); in orders mode only where an order is in progress,
 *   from the earliest head time of its jobs (`OrderOee.lineOrders`, the order OEE's queues) to its
 *   ADR-0031 completion, or the cut-off while open;
 * - the cut-off is the plant clock (the newest epoch's watermark, as the truth cuts at its snapshot),
 *   exclusive: a bucket reaching past it counts planned time and packs before it only (`through`);
 *   with every fact in, a bucket's value is the truth's whether or not it can be final yet;
 * - the line's final-through is the earliest final-through (ADR-0018) of the machines that
 *   contribute (schedule mode: the packing and bottleneck machines; orders mode: every machine of
 *   the line, whose facts decide completions, a CNC only as far as a job of it can still bring a
 *   fact: `LineOrders.cncThrough`), each other machine in the plant's newest epoch only (#257);
 *   it never passes the plant clock (without a clock nothing is final);
 * - device epochs: per bucket and machine only the newest epoch with data in it counts (a restarted
 *   simulator's run over the same plant time is never counted twice); a bucket with data of two
 *   epochs is never final; one with data of an ended run only (an epoch older than the machine's
 *   current one) may be final like any other (#257): the old epoch is closed at its watermark
 *   (ADR-0018), and the line's final-through counts a machine only once it is settled in the
 *   plant's newest epoch, so no newer run can still bring data into a bucket before it;
 * - `aboveOne`, not capped; `null` when the planned busy time is 0.
 *
 * **Finality:** a bucket is final when every input is final through its end: every contributing
 * machine final-through at or past it, the bottleneck's pieces covering it with none provisional,
 * and in orders mode the execution module having processed every machine through it (completions,
 * read after that snapshot), no `unknown-job` incident open on a CNC, and no job whose head time is
 * still unknown able to start in-progress time inside it (an unknown head time from its
 * `notBefore`; a waiting job only once its predecessor's order is complete). A lost head time never
 * resolves, so the buckets it can touch are never final. Written-off gaps on the contributing
 * machines (each in its own device epoch) overlapping the bucket are listed (`incidents`): a final
 * bucket over them carries `mayRevise` and the hours' `revision`, as the OEE buckets do.
 *
 * A final bucket without incidents never changes, so it is kept in memory (derive and cache; no
 * table, ADR-0022); a read computes only the buckets not kept. A new device epoch (the plant
 * clock's) drops them all (#257): a simulator restarted over the same plant time counts its own
 * run there, and a recomputation after an MES restart must give what the cache gives.
 */
import type { Millis, Range } from '@shopfloor/oee-core';
import {
  HOUR,
  NO_SHIFT,
  hourEnd,
  hourStart,
  shiftBuckets,
  shiftSegments,
  type ShiftBucket,
  type ShiftPattern,
} from '@shopfloor/shift-calendar';
import type { Equipment, StoredInterval } from '../equipment/index.ts';
import type { Execution } from '../execution/index.ts';
import type { Ingest, IngestNotice } from '../ingest/index.ts';
import {
  calendar,
  gapTouches,
  lineValue,
  maintenance,
  type LineModel,
  type LineValue,
  type Pack,
} from './line-inputs.ts';
import {
  piecesFinal,
  processedThrough,
  type LineOrders,
  type OrderGapIncident,
  type OrderLineView,
  type OrderOee,
} from './order-oee.ts';

export type ProductionMode = 'schedule' | 'orders';
export type LineBucketKind = 'hour' | 'shift';

/** What line OEE reads from the other modules (their `index.ts` interfaces). */
export interface LineOeeSources {
  readonly orderOee: Pick<OrderOee, 'lineOrders' | 'lineModel' | 'order' | 'onChange'>;
  readonly ingest: Pick<Ingest, 'deviceProgresses' | 'gapIncidents' | 'cycleResults' | 'onStored'>;
  readonly equipment: Pick<Equipment, 'intervals' | 'revision' | 'onPiecesChanged' | 'watermarks'>;
  readonly execution: Pick<Execution, 'processedThrough'>;
}

export interface LineOeeOptions extends LineOeeSources {
  readonly shiftPattern: ShiftPattern;
  /**
   * The plant's production mode (`MES_PRODUCTION_MODE`, the simulator's `SIM_PRODUCTION`): in
   * `orders` mode only in-progress time is planned (the line's counterpart of Idle `NO-ORDER`).
   */
  readonly productionMode: ProductionMode;
  /** Where a production-mode mismatch is reported (a warning, once per process). */
  readonly log?: { warn(object: object, message: string): void };
}

/** Line OEE of one hour or shift bucket (`GET /oee/line`, `oee:line`). */
export interface LineBucket {
  readonly bucket: LineBucketKind;
  /** The hour start (ISO 8601) or the shift key. */
  readonly key: string;
  readonly value: LineValue;
  /** Every input is final through the bucket's end (module comment). */
  readonly final: boolean;
  /** Written-off gaps on the contributing machines overlapping the bucket. */
  readonly incidents: readonly OrderGapIncident[];
  /** The bucket carries incidents: even final, it may still be revised. */
  readonly mayRevise: boolean;
  /** The highest revision of the incidents' machines' hours over the bucket; 0 without incidents. */
  readonly revision: number;
}

/** An order's line OEE over its in-progress time (`GET /oee/line/orders`). */
export interface LineOrderValue {
  readonly orderId: string;
  readonly product: string;
  readonly status: string;
  readonly line: OrderLineView;
  /** The order's OEE carries incidents (written-off gaps under it). */
  readonly incidents: readonly OrderGapIncident[];
  readonly mayRevise: boolean;
  readonly revision: number;
}

/** What may have moved a line bucket: a machine's hours, or (`orders`) the orders' state. */
export type LineChange =
  | { readonly equipment: string; readonly from: Date; readonly to: Date }
  | { readonly orders: true };

const cacheKey = (kind: LineBucketKind, key: string): string => `${kind}\u0000${key}`;

export class LineOee {
  readonly #options: LineOeeOptions;
  readonly #listeners = new Set<(change: LineChange) => void>();
  /** Final buckets without incidents never change (ADR-0018): kept so a read skips them. */
  readonly #finals = new Map<string, LineBucket>();
  /** The plant clock's device epoch the kept finals were derived under (#257). */
  #finalsEpoch: number | undefined;
  #model: LineModel | undefined;
  #warned = false;
  #detach: (() => void)[] = [];

  constructor(options: LineOeeOptions) {
    this.#options = options;
  }

  get productionMode(): ProductionMode {
    return this.#options.productionMode;
  }

  /** The line's machines and its designed bottleneck per product. */
  async model(): Promise<LineModel> {
    this.#model ??= await this.#options.orderOee.lineModel();
    return this.#model;
  }

  /** The machines whose facts a bucket reads (module comment). */
  #contributing(model: LineModel): string[] {
    return this.#options.productionMode === 'orders'
      ? [...model.machines]
      : [...new Set([...model.packing, ...model.bottleneckMachines])].sort();
  }

  /** Follows the changes line OEE is computed from (for push), filtered to what it reads. */
  async start(): Promise<void> {
    const model = await this.model();
    const contributing = new Set(this.#contributing(model));
    const packing = new Set(model.packing);
    const { equipment, ingest, orderOee } = this.#options;
    this.#detach.push(
      equipment.onPiecesChanged((change) => {
        if (contributing.has(change.equipment)) {
          this.#emit({ equipment: change.equipment, from: change.from, to: change.to });
        }
      }),
      ingest.onStored((notice: IngestNotice) => {
        if (notice.type === 'job') this.#mismatch('a job fact', notice.fact.equipment);
        if (notice.type !== 'cycle' || !packing.has(notice.cycle.equipment)) return;
        const hour = hourStart(notice.cycle.sourceTime.getTime());
        this.#emit({
          equipment: notice.cycle.equipment,
          from: new Date(hour),
          to: new Date(hour + HOUR),
        });
      }),
    );
    this.#detach.push(
      orderOee.onChange((change) => {
        if (this.#options.productionMode === 'orders') this.#emit({ orders: true });
        else if (change.machine !== undefined) this.#mismatch('a dispatch command', change.machine);
      }),
    );
  }

  /** Whether a production-mode mismatch was reported (it is, once). */
  get mismatch(): boolean {
    return this.#warned;
  }

  /**
   * A job fact or a dispatch command while the MES plans line OEE in schedule mode: the plant runs
   * orders and `MES_PRODUCTION_MODE` disagrees with the simulator's `SIM_PRODUCTION`, so every
   * scheduled moment counts as planned. Reported once as a warning (#232 review).
   */
  #mismatch(what: string, equipment: string): void {
    if (this.#options.productionMode !== 'schedule' || this.#warned) return;
    this.#warned = true;
    this.#options.log?.warn(
      { equipment, productionMode: this.#options.productionMode },
      `line OEE: ${what} while MES_PRODUCTION_MODE=schedule; set it to the simulator's SIM_PRODUCTION (orders)`,
    );
  }

  stop(): void {
    for (const detach of this.#detach.splice(0)) detach();
  }

  /**
   * Listens for changes that may move a line bucket (synchronously, inside the modules' notices:
   * the listener must only record what changed). Returns an unsubscribe.
   */
  onChange(listener: (change: LineChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(change: LineChange): void {
    for (const listener of this.#listeners) {
      try {
        listener(change);
      } catch {
        // A listener's failure must not reach the notifying module.
      }
    }
  }

  /**
   * Line OEE buckets over [from, to): every UTC hour overlapping it, or every shift bucket
   * overlapping it (whole shifts, no `no-shift` stretch: it has no planned time), by start.
   */
  async buckets(query: {
    readonly bucket: LineBucketKind;
    readonly from: Date;
    readonly to: Date;
  }): Promise<LineBucket[]> {
    const from = query.from.getTime();
    const to = query.to.getTime();
    const defs: ShiftBucket[] =
      query.bucket === 'hour'
        ? hours(hourStart(from), hourEnd(to))
        : shiftBuckets(this.#options.shiftPattern, from, to).filter((b) => b.key !== NO_SHIFT);
    return this.#compute(query.bucket, defs);
  }

  /** The hour and the shift bucket the plant clock (the newest epoch's watermark) is in. */
  async current(): Promise<{ hour: LineBucket | null; shift: LineBucket | null }> {
    const clock = this.#options.equipment.watermarks()[0];
    if (!clock) return { hour: null, shift: null };
    // The instant just before the watermark: at 07:00:00.000 the hour in progress is 06:00.
    const at = clock.watermark.getTime() - 1;
    const hour = {
      key: new Date(hourStart(at)).toISOString(),
      start: hourStart(at),
      end: hourStart(at) + HOUR,
    };
    const segment = shiftSegments(this.#options.shiftPattern, at, at + 1)[0];
    const shift =
      segment === undefined || segment.key === NO_SHIFT
        ? undefined
        : shiftBuckets(this.#options.shiftPattern, at, at + 1).find((b) => b.key === segment.key);
    const [hourBucket] = await this.#compute('hour', [hour]);
    const [shiftBucket] = shift ? await this.#compute('shift', [shift]) : [];
    return { hour: hourBucket ?? null, shift: shiftBucket ?? null };
  }

  /**
   * The line OEE of every order whose in-progress time overlaps [from, to) (orders mode; empty in
   * schedule mode), from its order OEE view (`OrderOee.order(id).line`), by in-progress start.
   */
  async orders(query: { readonly from: Date; readonly to: Date }): Promise<LineOrderValue[]> {
    if (this.#options.productionMode !== 'orders') return [];
    const from = query.from.getTime();
    const to = query.to.getTime();
    const { orders } = await this.#options.orderOee.lineOrders();
    const result: LineOrderValue[] = [];
    for (const entry of orders) {
      if (entry.from === null || entry.from >= to) continue;
      if (entry.completedAt !== null && entry.completedAt < from) continue;
      const view = await this.#options.orderOee.order(entry.orderId);
      if (!view?.line) continue;
      result.push({
        orderId: view.orderId,
        product: view.product,
        status: view.status,
        line: view.line,
        incidents: view.incidents,
        mayRevise: view.mayRevise,
        revision: view.revision,
      });
    }
    return result.sort(
      (a, b) => a.line.value.from - b.line.value.from || (a.orderId < b.orderId ? -1 : 1),
    );
  }

  async #compute(kind: LineBucketKind, defs: readonly ShiftBucket[]): Promise<LineBucket[]> {
    // The plant clock, read once: a new device epoch drops the kept finals (module comment).
    const clock = this.#options.equipment.watermarks()[0];
    if (clock?.epoch !== this.#finalsEpoch) {
      this.#finals.clear();
      this.#finalsEpoch = clock?.epoch;
    }
    const done = new Map<string, LineBucket>();
    const todo = defs.filter((def) => {
      const cached = this.#finals.get(cacheKey(kind, def.key));
      if (cached) done.set(def.key, cached);
      return !cached;
    });
    if (todo.length > 0) {
      for (const bucket of await this.#derive(kind, todo, clock)) done.set(bucket.key, bucket);
    }
    return defs.flatMap((def) => {
      const bucket = done.get(def.key);
      return bucket ? [bucket] : [];
    });
  }

  async #derive(
    kind: LineBucketKind,
    defs: readonly ShiftBucket[],
    plantClock: { readonly epoch: number; readonly watermark: Date } | undefined,
  ): Promise<LineBucket[]> {
    const { ingest, equipment, execution, orderOee, shiftPattern } = this.#options;
    const orders = this.#options.productionMode === 'orders';
    const model = await this.model();
    const span: Range = {
      from: Math.min(...defs.map((d) => d.start)),
      to: Math.max(...defs.map((d) => d.end)),
    };
    // Execution's progress first: a completion before it is already recorded (module comment).
    const processed = execution.processedThrough();
    const contributing = this.#contributing(model);
    const progress = await ingest.deviceProgresses(contributing);
    // Orders mode: the orders' in-progress time, and how far each CNC's facts are known.
    let lineOrders: LineOrders | undefined;
    if (orders) lineOrders = await orderOee.lineOrders();
    // The plant clock cuts what is counted; the line's final-through, the earliest of the
    // contributing machines' (a CNC's as far as its jobs can still bring a fact), decides finality.
    // It never passes the clock: a bucket counted short is never final (without a clock, nothing is).
    const clock = plantClock?.watermark.getTime() ?? Number.NEGATIVE_INFINITY;
    const newest = plantClock?.epoch;
    const finalThrough = (machine: string): Millis =>
      progress.get(machine)?.settledTime?.getTime() ?? Number.NEGATIVE_INFINITY;
    let cut = contributing.length === 0 ? Number.NEGATIVE_INFINITY : clock;
    for (const machine of contributing) {
      // A machine counts only once it is settled in the plant's newest epoch (#257): until then
      // that run may still bring its data anywhere after its start, before the bucket's end too.
      const through =
        lineOrders && model.first.includes(machine)
          ? (lineOrders.cncThrough.get(machine) ?? Number.POSITIVE_INFINITY)
          : progress.get(machine)?.epoch === newest
            ? finalThrough(machine)
            : Number.NEGATIVE_INFINITY;
      cut = Math.min(cut, through);
    }
    // Good packed before the plant clock, with their device epoch.
    const packs: (Pack & { machine: string; epoch: number })[] = [];
    const readTo = Math.min(span.to, clock);
    if (readTo > span.from) {
      for (const machine of model.packing) {
        for (const cycle of await ingest.cycleResults(
          machine,
          new Date(span.from),
          new Date(readTo),
        )) {
          if (cycle.result === 'good') {
            packs.push({
              at: cycle.at.getTime(),
              product: cycle.product,
              machine,
              epoch: cycle.epoch,
            });
          }
        }
      }
    }
    // The calendar and the bottleneck's pieces (its Maintenance is a planned stop).
    const { scheduled, breaks } = calendar(shiftPattern, span);
    const bottleneckPieces = new Map<string, StoredInterval[]>();
    for (const machine of model.bottleneckMachines) {
      bottleneckPieces.set(
        machine,
        await equipment.intervals(machine, new Date(span.from), new Date(span.to)),
      );
    }
    let inProgress: Range[] | undefined;
    if (lineOrders) {
      inProgress = lineOrders.orders.flatMap((o) =>
        o.from === null ? [] : [{ from: o.from, to: o.completedAt ?? Math.max(o.from, clock) }],
      );
    }
    // Written-off gaps on the contributing machines, each in its own device epoch, and in every
    // ended run whose data a bucket counts (#257: its closed epoch's gaps lie under that data).
    const current = (machine: string): number | undefined =>
      progress.get(machine)?.epoch ?? undefined;
    const runs = new Set<number>([
      ...packs.map((p) => p.epoch),
      ...[...bottleneckPieces.values()].flatMap((all) => all.map((p) => p.epoch)),
    ]);
    const streams = contributing.flatMap((machine) => {
      const own = current(machine);
      const epochs = new Set([...(own === undefined ? [] : [own]), ...runs]);
      return [...epochs].sort((a, b) => a - b).map((epoch) => ({ equipment: machine, epoch }));
    });
    const gaps = await ingest.gapIncidents(streams);
    const result: LineBucket[] = [];
    for (const def of defs) {
      const bucket = { from: def.start, to: def.end };
      // The epoch rule (ADR-0036 P9-05 amendment, #257): per machine, only the newest device epoch
      // with data in the bucket counts, so a simulator restarted over the same plant time is never
      // counted twice; a bucket with data of two epochs is never final, one with an ended run's
      // data alone may be (the line's final-through then guards against a newer run).
      let epochsOk = true;
      const counted: Pack[] = [];
      const bucketRuns = new Set<number>();
      for (const machine of model.packing) {
        const inBucket = packs.filter(
          (p) => p.machine === machine && p.at >= bucket.from && p.at < bucket.to,
        );
        const epoch = newestEpoch(inBucket);
        if (epoch === undefined) continue;
        epochsOk &&= oneRun(inBucket, epoch, current(machine));
        bucketRuns.add(epoch);
        counted.push(...inBucket.filter((p) => p.epoch === epoch));
      }
      const stops: Range[] = [...breaks];
      let piecesOk = true;
      for (const [machine, all] of bottleneckPieces) {
        const inBucket = all.filter(
          (p) => p.end.getTime() > bucket.from && p.start.getTime() < bucket.to,
        );
        const epoch = newestEpoch(inBucket);
        const chosen = inBucket.filter((p) => p.epoch === epoch);
        epochsOk &&= epoch === undefined || oneRun(inBucket, epoch, current(machine));
        if (epoch !== undefined) bucketRuns.add(epoch);
        stops.push(...maintenance(chosen));
        piecesOk &&= piecesFinal(chosen, bucket);
      }
      const value = lineValue({
        bucket,
        cut: clock,
        scheduled,
        plannedStops: stops,
        inProgress,
        packs: counted,
        effectiveCycleMs: model.effectiveCycleMs,
      });
      const incidents = gaps
        .filter(
          (gap) =>
            (gap.epoch === current(gap.equipment) || bucketRuns.has(gap.epoch)) &&
            gapTouches(gap, bucket.from, bucket.to),
        )
        .map(({ equipment: machine, epoch, id, seqFrom, seqTo }) => ({
          machine,
          epoch,
          id,
          seqFrom,
          seqTo,
        }));
      const final =
        cut >= bucket.to &&
        epochsOk &&
        piecesOk &&
        (!orders ||
          (lineOrders !== undefined &&
            ordersFinal(bucket, lineOrders, model, (machine) =>
              // Through the bucket's end, or all of a quiet CNC's facts (up to its final-through).
              processedThrough(
                processed.get(machine),
                { epoch: progress.get(machine)?.epoch ?? Number.NaN },
                Math.min(bucket.to, finalThrough(machine)),
              ),
            )));
      let revision = 0;
      for (const { machine, epoch } of uniqueMachines(incidents)) {
        revision = Math.max(
          revision,
          await equipment.revision(machine, epoch, new Date(bucket.from), new Date(bucket.to)),
        );
      }
      const line: LineBucket = {
        bucket: kind,
        key: def.key,
        value,
        final,
        incidents,
        mayRevise: incidents.length > 0,
        revision,
      };
      // Kept only under the epoch it was derived in (a newer one may have dropped the cache since).
      if (final && incidents.length === 0 && this.#finalsEpoch === newest) {
        this.#finals.set(cacheKey(kind, def.key), line);
      }
      result.push(line);
    }
    return result;
  }
}

/** The newest device epoch among the items; undefined without items. */
function newestEpoch(items: readonly { readonly epoch: number }[]): number | undefined {
  let newest: number | undefined;
  for (const { epoch } of items) if (newest === undefined || epoch > newest) newest = epoch;
  return newest;
}

/**
 * Every item of `epoch` (no newer run has data beside it), and that epoch the machine's current
 * one or an ended run before it (#257).
 */
function oneRun(
  items: readonly { readonly epoch: number }[],
  epoch: number,
  current: number | null | undefined,
): boolean {
  return (
    current !== null &&
    current !== undefined &&
    epoch <= current &&
    items.every((item) => item.epoch === epoch)
  );
}

/** Whole UTC hours [from, to). */
function hours(from: Millis, to: Millis): ShiftBucket[] {
  const result: ShiftBucket[] = [];
  for (let hour = from; hour < to; hour += HOUR) {
    result.push({ key: new Date(hour).toISOString(), start: hour, end: hour + HOUR });
  }
  return result;
}

function uniqueMachines(
  incidents: readonly OrderGapIncident[],
): { machine: string; epoch: number }[] {
  const seen = new Map<string, { machine: string; epoch: number }>();
  for (const { machine, epoch } of incidents)
    seen.set(`${machine}\u0000${String(epoch)}`, { machine, epoch });
  return [...seen.values()];
}

/**
 * The orders-mode part of a bucket's finality (module comment): every line machine processed by
 * execution through the bucket's end, no `unknown-job` incident open on a CNC, and no job without
 * a known head time able to start in-progress time inside the bucket.
 */
export function ordersFinal(
  bucket: Range,
  lineOrders: LineOrders,
  model: Pick<LineModel, 'machines' | 'first'>,
  processed: (machine: string) => boolean,
): boolean {
  if (!model.machines.every(processed)) return false;
  if (model.first.some((cnc) => lineOrders.unknownJob.has(cnc))) return false;
  const completion = new Map(lineOrders.orders.map((o) => [o.orderId, o.completedAt]));
  for (const order of lineOrders.orders) {
    // An order complete before the bucket can't reach into it, whatever its start.
    if (order.completedAt !== null && order.completedAt <= bucket.from) continue;
    for (const job of order.unknown) {
      let earliest = job.notBefore;
      if (job.reason === 'waiting') {
        // While its predecessor's order is open, that order is in progress up to the cut-off and
        // covers this job's time: only a complete predecessor order leaves a hole it may fill.
        const before = job.after === null ? null : (completion.get(job.after) ?? null);
        if (before === null) continue;
        earliest = Math.max(earliest, before);
      }
      if (bucket.to > earliest) return false;
    }
  }
  return true;
}
