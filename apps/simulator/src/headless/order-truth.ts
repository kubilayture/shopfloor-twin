/**
 * The order part of the ground truth (#172, ADR-0030): per job, per order and per unit (part), as
 * the MES's `orders` and `execution` modules must reconstruct them from device facts. Everything
 * here is derived from plant events only, as the MES derives it (the WIP at the end is read from
 * the line, the one thing facts can't show directly):
 *
 * - a part belongs to the job whose `started` fact is the latest one on its CNC before its OP10
 *   cycle (one part at a time on a CNC), and every later cycle of the part inherits the order;
 * - material is booked when the consuming cycle completes (H2): a blank with the part's OP10 cycle,
 *   components with its OP30 cycle of that pass. What was taken for a cycle still running at the
 *   end is `materialInProcess`, not booked;
 * - quantities per operation count completed cycles, every pass: `in = good + scrap + rework`.
 *
 * In schedule mode there are no jobs, so the section is empty.
 */
import { createHash } from 'node:crypto';
import type { PlantConfig } from '@shopfloor/plant-config';
import type { SimTime } from '@shopfloor/sim-core';
import type { Part } from '../plant/buffer.ts';
import type { PlantEvent, ProductionLine } from '../plant/line.ts';
import { isoTime, stableStringify } from './serialize.ts';

export interface JobTruthJson {
  readonly commandId: string;
  readonly orderId: string;
  readonly machine: string;
  readonly product: string;
  readonly quantity: number;
  readonly acceptedAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

/** Completed cycles at one operation, every pass. */
export interface OperationQuantities {
  readonly in: number;
  readonly good: number;
  readonly scrap: number;
  readonly rework: number;
}

export interface OrderTruthJson {
  readonly product: string;
  /** The order's jobs, by command id, in acceptance order. */
  readonly jobs: readonly string[];
  /** Σ quantity of its accepted jobs (blanks to machine). */
  readonly quantity: number;
  /** Blanks taken (OP10 cycles begun). */
  readonly started: number;
  /** Scrapped units per operation and reason (OP10 `DIMENSIONAL`, OP40 second `LEAK`). */
  readonly scrap: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** Leak-test failures that sent a unit back to OP30 (each opens pass 2 at OP30 and OP40). */
  readonly reworkPasses: number;
  /** Units packed good at the last operation. */
  readonly packedGood: number;
  /** Units not in a terminal state at the end, per place (`cnc-01`, `OP20→OP30`, `asm-01 rework`). */
  readonly wip: Readonly<Record<string, number>>;
  /** When the order's last unit reached a terminal state (packed or scrapped) so far. */
  readonly lastTerminalAt: string | null;
  /** When the order was complete: every job completed and every unit terminal; null until then. */
  readonly completedAt: string | null;
  readonly operations: Readonly<Record<string, OperationQuantities>>;
  /** Material booked at cycle completion, per material id. */
  readonly material: Readonly<Record<string, number>>;
  /** Material taken for cycles still running at the end: not visible to the MES, not reconciled. */
  readonly materialInProcess: Readonly<Record<string, number>>;
}

export interface UnitRecordJson {
  readonly operation: string;
  readonly equipment: string;
  readonly pass: number;
  readonly at: string;
  readonly result: 'good' | 'scrap' | 'rework';
  readonly reason?: string;
}

export interface UnitJson {
  readonly partId: number;
  readonly serial: string;
  readonly orderId: string;
  readonly records: readonly UnitRecordJson[];
}

export interface OrdersSummary {
  /** Every accepted job, in acceptance order. */
  readonly jobs: readonly JobTruthJson[];
  readonly orders: Readonly<Record<string, OrderTruthJson>>;
  /**
   * Every unit's operation records: their count and the SHA-256 of `unitsDocument` (the tests
   * derive the full list from the event log and compare).
   */
  readonly units: { readonly count: number; readonly sha256: string };
}

interface Job {
  readonly view: { -readonly [K in keyof JobTruthJson]: JobTruthJson[K] };
}

interface Unit {
  readonly partId: number;
  serial: string;
  readonly orderId: string;
  readonly records: UnitRecordJson[];
  reworks: number;
}

interface Order {
  readonly product: string;
  readonly jobs: string[];
  quantity: number;
  started: number;
  readonly scrap: Map<string, Map<string, number>>;
  reworkPasses: number;
  packedGood: number;
  lastTerminalAt: SimTime | undefined;
  readonly operations: Map<string, { in: number; good: number; scrap: number; rework: number }>;
  readonly material: Map<string, number>;
}

const add = (map: Map<string, number>, key: string, n = 1): void => {
  map.set(key, (map.get(key) ?? 0) + n);
};

const sorted = <T>(entries: Iterable<[string, T]>): Record<string, T> =>
  Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** The canonical document `units.sha256` hashes: every unit by part id, its records in order. */
export const unitsDocument = (units: readonly UnitJson[]): string => stableStringify(units);

export const unitsHash = (units: readonly UnitJson[]): string =>
  createHash('sha256').update(unitsDocument(units)).digest('hex');

export class OrderTruth {
  readonly #operation: ReadonlyMap<string, string>;
  readonly #firstOperation: string;
  readonly #lastOperation: string;
  readonly #reworkOperations: ReadonlySet<string>;
  readonly #jobs = new Map<string, Job>();
  readonly #orders = new Map<string, Order>();
  readonly #units = new Map<number, Unit>();
  /** The job a CNC works on: its latest `started` fact. */
  readonly #current = new Map<string, string>();
  /** Material taken for a cycle not completed yet, by `machine␀partId`. */
  readonly #pending = new Map<string, string[]>();

  constructor(config: PlantConfig) {
    this.#operation = new Map(
      config.plant.areas.flatMap((a) =>
        a.workCenters.flatMap((w) => w.equipment.map((e) => [e.id, e.operation] as const)),
      ),
    );
    const operations = config.products.operations;
    this.#firstOperation = operations[0] ?? 'OP10';
    this.#lastOperation = operations.at(-1) ?? 'OP50';
    this.#reworkOperations = new Set([
      config.process.leakTest.reworkOperation,
      config.process.leakTest.operation,
    ]);
  }

  record(event: PlantEvent): void {
    switch (event.type) {
      case 'job':
        this.#onJob(event);
        break;
      case 'material-consumed':
        this.#onMaterial(event);
        break;
      case 'cycle-complete':
        this.#onCycle(event);
        break;
      case 'state':
      case 'alarm':
      case 'shift':
      case 'operator':
      case 'repair-start':
      case 'repair-end':
      case 'program-loaded':
      case 'injection-held':
      case 'injection-applied':
      case 'leak-drift':
      case 'lot':
      case 'absence':
      case 'tool-breakage':
        break;
    }
  }

  #onJob(event: Extract<PlantEvent, { type: 'job' }>): void {
    if (event.transition === 'accepted') {
      this.#jobs.set(event.commandId, {
        view: {
          commandId: event.commandId,
          orderId: event.orderId,
          machine: event.machineId,
          product: event.product,
          quantity: event.quantity,
          acceptedAt: isoTime(event.at),
          startedAt: null,
          completedAt: null,
        },
      });
      const order = this.#order(event.orderId, event.product);
      order.jobs.push(event.commandId);
      order.quantity += event.quantity;
      return;
    }
    const job = this.#jobs.get(event.commandId);
    if (!job) {
      throw new RangeError(`job ${event.commandId} ${event.transition} before it was accepted`);
    }
    if (event.transition === 'started') {
      job.view.startedAt = isoTime(event.at);
      this.#current.set(event.machineId, event.commandId);
    } else {
      job.view.completedAt = isoTime(event.at);
    }
  }

  /** The order of a part: known once its blank was taken on a CNC working on a job. */
  #unitOf(machineId: string, partId: number): Unit | undefined {
    const known = this.#units.get(partId);
    if (known) return known;
    if (this.#operation.get(machineId) !== this.#firstOperation) return undefined;
    const commandId = this.#current.get(machineId);
    const job = commandId === undefined ? undefined : this.#jobs.get(commandId);
    if (!job) return undefined;
    const unit: Unit = {
      partId,
      serial: '',
      orderId: job.view.orderId,
      records: [],
      reworks: 0,
    };
    this.#units.set(partId, unit);
    this.#order(job.view.orderId, job.view.product).started++;
    return unit;
  }

  #onMaterial(event: Extract<PlantEvent, { type: 'material-consumed' }>): void {
    if (!this.#unitOf(event.machineId, event.partId)) return;
    const key = `${event.machineId}\u0000${String(event.partId)}`;
    this.#pending.set(key, [...(this.#pending.get(key) ?? []), event.material]);
  }

  #onCycle(event: Extract<PlantEvent, { type: 'cycle-complete' }>): void {
    const unit = this.#unitOf(event.machineId, event.partId);
    if (!unit) return;
    const order = this.#orders.get(unit.orderId);
    const operation = this.#operation.get(event.machineId);
    if (!order || operation === undefined) {
      throw new RangeError(`cycle of part ${String(event.partId)} on ${event.machineId}`);
    }
    if (event.serial !== '') unit.serial = event.serial;
    const pass = this.#reworkOperations.has(operation) ? unit.reworks + 1 : 1;
    unit.records.push({
      operation,
      equipment: event.machineId,
      pass,
      at: isoTime(event.at),
      result: event.result,
      ...(event.reason === undefined ? {} : { reason: event.reason }),
    });
    const quantities = order.operations.get(operation) ?? { in: 0, good: 0, scrap: 0, rework: 0 };
    quantities.in++;
    quantities[event.result]++;
    order.operations.set(operation, quantities);
    const key = `${event.machineId}\u0000${String(event.partId)}`;
    for (const material of this.#pending.get(key) ?? []) {
      add(order.material, material);
    }
    this.#pending.delete(key);
    if (event.result === 'rework') {
      unit.reworks++;
      order.reworkPasses++;
    } else if (event.result === 'scrap') {
      const byReason = order.scrap.get(operation) ?? new Map<string, number>();
      add(byReason, event.reason ?? 'UNKNOWN');
      order.scrap.set(operation, byReason);
      order.lastTerminalAt = event.at;
    } else if (operation === this.#lastOperation) {
      order.packedGood++;
      order.lastTerminalAt = event.at;
    }
  }

  #order(orderId: string, product: string): Order {
    let order = this.#orders.get(orderId);
    if (!order) {
      order = {
        product,
        jobs: [],
        quantity: 0,
        started: 0,
        scrap: new Map(),
        reworkPasses: 0,
        packedGood: 0,
        lastTerminalAt: undefined,
        operations: new Map(),
        material: new Map(),
      };
      this.#orders.set(orderId, order);
    }
    return order;
  }

  /** Every unit with its records, by part id (the document `units.sha256` hashes). */
  units(): UnitJson[] {
    return [...this.#units.values()]
      .sort((a, b) => a.partId - b.partId)
      .map((unit) => ({
        partId: unit.partId,
        serial: unit.serial,
        orderId: unit.orderId,
        records: unit.records.map((record) => ({ ...record })),
      }));
  }

  /** The section at the end (or now, live): WIP is read from the line's buffers and stations. */
  summary(line: ProductionLine): OrdersSummary {
    const wip = new Map<string, Map<string, number>>();
    const place = (where: string, parts: readonly Part[]): void => {
      for (const part of parts) {
        const unit = this.#units.get(part.id);
        if (!unit) continue;
        const perOrder = wip.get(unit.orderId) ?? new Map<string, number>();
        add(perOrder, where);
        wip.set(unit.orderId, perOrder);
      }
    };
    for (const buffer of line.buffers) {
      place(`${buffer.from}→${buffer.to}`, buffer.contents());
    }
    for (const station of line.stations) {
      place(station.id, station.part ? [station.part] : []);
      place(`${station.id} rework`, station.rework ?? []);
    }
    const inProcess = new Map<string, Map<string, number>>();
    for (const [key, materials] of this.#pending) {
      const partId = Number(key.split('\u0000')[1]);
      const unit = this.#units.get(partId);
      if (!unit) continue;
      const perOrder = inProcess.get(unit.orderId) ?? new Map<string, number>();
      for (const material of materials) add(perOrder, material);
      inProcess.set(unit.orderId, perOrder);
    }
    const orders = sorted(
      [...this.#orders].map(([orderId, order]): [string, OrderTruthJson] => {
        const orderWip = wip.get(orderId) ?? new Map<string, number>();
        const jobsDone = order.jobs.every(
          (commandId) => this.#jobs.get(commandId)?.view.completedAt !== null,
        );
        const complete = jobsDone && orderWip.size === 0 && order.started === order.quantity;
        return [
          orderId,
          {
            product: order.product,
            jobs: [...order.jobs],
            quantity: order.quantity,
            started: order.started,
            scrap: sorted(
              [...order.scrap].map(([operation, reasons]) => [operation, sorted(reasons)]),
            ),
            reworkPasses: order.reworkPasses,
            packedGood: order.packedGood,
            wip: sorted(orderWip),
            lastTerminalAt:
              order.lastTerminalAt === undefined ? null : isoTime(order.lastTerminalAt),
            completedAt:
              complete && order.lastTerminalAt !== undefined ? isoTime(order.lastTerminalAt) : null,
            operations: sorted([...order.operations].map(([op, q]) => [op, { ...q }])),
            material: sorted(order.material),
            materialInProcess: sorted(inProcess.get(orderId) ?? new Map<string, number>()),
          },
        ];
      }),
    );
    const units = this.units();
    return {
      jobs: [...this.#jobs.values()].map((job) => ({ ...job.view })),
      orders,
      units: { count: units.length, sha256: unitsHash(units) },
    };
  }
}
