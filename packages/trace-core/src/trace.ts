/**
 * The trace tree (Phase 8 plan "Ground truth for traceability and SPC", ADR-0034): units with
 * their records, lots and operators, cartons, lots forward, and the SPC chart of the leak test,
 * all derived from one input by the same definitions the MES uses, and cut at a time by
 * {@link traceAsOf}.
 */
import {
  firstVersion,
  spcChart,
  type LimitVersion,
  type Reading,
  type RuleSet,
  type SpcChart,
} from '@shopfloor/spc-core';
import type { LotRef } from './consumption.ts';
import {
  compareUnits,
  packCartons,
  unitId,
  type Carton,
  type Millis,
  type OrderPacking,
  type Pack,
  type UnitKey,
} from './packing.ts';

export type CycleResult = 'good' | 'scrap' | 'rework';

/** One completed cycle of a unit: an operation record (ADR-0031) with what it consumed and measured. */
export interface TraceRecord {
  readonly operation: string;
  readonly pass: number;
  readonly machine: string;
  /** Completion time. */
  readonly at: Millis;
  /** Device sequence: orders a machine's facts at one plant time. */
  readonly seq: number;
  readonly result: CycleResult;
  readonly reason: string | null;
  readonly lots: readonly LotRef[];
  /** The device operator at the cycle's start, where the machine has one. */
  readonly operator: string | null;
  /** The measured value in resolution steps (the leak test), else `null`. */
  readonly reading: number | null;
}

export interface UnitInput extends UnitKey {
  readonly serial: string;
  readonly product: string;
  /** `null` in schedule mode. */
  readonly orderId: string | null;
  readonly records: readonly TraceRecord[];
}

export interface SpcConfig {
  readonly characteristic: string;
  /** The operation whose readings form the characteristic (`OP40`). */
  readonly operation: string;
  readonly subgroupSize: number;
  readonly baselineSubgroups: number;
  readonly rules: RuleSet;
}

export interface TraceConfig {
  /** The operation whose good cycles pack a unit (`OP50`). */
  readonly packOperation: string;
  /** Carton capacity per product (`packing.yaml`). */
  readonly capacity: Readonly<Record<string, number>>;
  readonly spc: SpcConfig;
}

export interface TraceInput {
  readonly config: TraceConfig;
  readonly units: readonly UnitInput[];
  readonly orders: readonly OrderPacking[];
  /**
   * The limit versions. Left out, version 1 is estimated from the baseline of these readings
   * (the ground truth); given, they are used as they are (frozen, as `traceAsOf` keeps them).
   */
  readonly limits?: readonly LimitVersion[];
}

export type UnitStatus = 'wip' | 'scrapped' | 'packed';

export interface TraceUnit extends UnitInput {
  readonly status: UnitStatus;
  readonly carton: string | null;
}

/** A lot forward: what consumed it, and where those units went. */
export interface TraceLot {
  readonly lot: string;
  readonly material: string;
  /**
   * Pieces consumed: the number of lot references naming it, over every record of every unit
   * (a record lists one reference per piece it consumed, so a record taking two pieces of one lot
   * would count two).
   */
  readonly consumed: number;
  readonly units: readonly UnitKey[];
  readonly orders: readonly string[];
  readonly cartons: readonly string[];
}

export interface TraceSpc {
  readonly characteristic: string;
  readonly readings: readonly Reading[];
  readonly limits: readonly LimitVersion[];
  readonly chart: SpcChart;
}

export interface Trace {
  readonly config: TraceConfig;
  readonly orders: readonly OrderPacking[];
  /** By (epoch, `partId`); records by completion time, then sequence. */
  readonly units: readonly TraceUnit[];
  /** By lot id. */
  readonly lots: readonly TraceLot[];
  /** By order (as given), then number. */
  readonly cartons: readonly Carton[];
  readonly spc: TraceSpc;
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const compareRecords = (a: TraceRecord, b: TraceRecord): number => a.at - b.at || a.seq - b.seq;

/** A reading's key: the unit and its pass at the characteristic's operation. */
export const readingKey = (unit: UnitKey, pass: number): string =>
  `${unitId(unit)}/${String(pass)}`;

/** `scrapped` after a scrap result, `packed` after a good cycle at the packing operation. */
export function unitStatus(records: readonly TraceRecord[], packOperation: string): UnitStatus {
  if (records.some((r) => r.result === 'scrap')) return 'scrapped';
  if (records.some((r) => r.operation === packOperation && r.result === 'good')) return 'packed';
  return 'wip';
}

/** The characteristic's readings, every pass: SPC keeps first passes and lists retests. */
export function spcReadings(units: readonly UnitInput[], operation: string): Reading[] {
  return units.flatMap((unit) =>
    unit.records
      .filter((r) => r.operation === operation && r.reading !== null)
      .map((r) => ({
        key: readingKey(unit, r.pass),
        epoch: unit.epoch,
        at: r.at,
        seq: r.seq,
        pass: r.pass,
        value: r.reading ?? 0,
      })),
  );
}

/** Derives the whole tree from its input. */
export function buildTrace(input: TraceInput): Trace {
  const { config } = input;
  const units = [...input.units]
    .sort(compareUnits)
    .map((unit) => ({ ...unit, records: [...unit.records].sort(compareRecords) }));
  for (let i = 1; i < units.length; i += 1) {
    const [a, b] = [units[i - 1], units[i]];
    if (a && b && compareUnits(a, b) === 0) {
      throw new RangeError(`unit ${unitId(b)} given twice`);
    }
  }

  const packs: Pack[] = units.flatMap((unit) =>
    unit.orderId === null
      ? []
      : unit.records
          .filter((r) => r.operation === config.packOperation && r.result === 'good')
          .map((r) => ({
            unit: { epoch: unit.epoch, partId: unit.partId },
            orderId: unit.orderId ?? '',
            at: r.at,
            seq: r.seq,
          })),
  );
  const cartons = packCartons(input.orders, packs, config.capacity);
  const cartonOf = new Map<string, string>();
  for (const carton of cartons) {
    for (const member of carton.members) cartonOf.set(unitId(member), carton.id);
  }

  const traced: TraceUnit[] = units.map((unit) => ({
    ...unit,
    status: unitStatus(unit.records, config.packOperation),
    carton: cartonOf.get(unitId(unit)) ?? null,
  }));

  const readings = spcReadings(units, config.spc.operation);
  const limits =
    input.limits ??
    [firstVersion(readings, config.spc)].filter((v): v is LimitVersion => v !== null);

  return {
    config,
    orders: input.orders,
    units: traced,
    lots: lotsOf(traced),
    cartons,
    spc: {
      characteristic: config.spc.characteristic,
      readings,
      limits,
      chart: spcChart({
        readings,
        versions: limits,
        rules: config.spc.rules,
        subgroupSize: config.spc.subgroupSize,
      }),
    },
  };
}

interface LotAccumulator {
  material: string;
  consumed: number;
  readonly units: Map<string, UnitKey>;
  readonly orders: Set<string>;
  readonly cartons: Set<string>;
}

function lotsOf(units: readonly TraceUnit[]): TraceLot[] {
  const lots = new Map<string, LotAccumulator>();
  for (const unit of units) {
    for (const record of unit.records) {
      for (const ref of record.lots) {
        let lot = lots.get(ref.lot);
        if (!lot) {
          lot = {
            material: ref.material,
            consumed: 0,
            units: new Map(),
            orders: new Set(),
            cartons: new Set(),
          };
          lots.set(ref.lot, lot);
        }
        if (lot.material !== ref.material) {
          throw new RangeError(`lot ${ref.lot} named as ${lot.material} and ${ref.material}`);
        }
        lot.consumed += 1;
        lot.units.set(unitId(unit), { epoch: unit.epoch, partId: unit.partId });
        if (unit.orderId !== null) lot.orders.add(unit.orderId);
        if (unit.carton !== null) lot.cartons.add(unit.carton);
      }
    }
  }
  return [...lots.entries()]
    .sort(([a], [b]) => byText(a, b))
    .map(([lot, acc]) => ({
      lot,
      material: acc.material,
      consumed: acc.consumed,
      units: [...acc.units.values()].sort(compareUnits),
      orders: [...acc.orders].sort(byText),
      cartons: [...acc.cartons].sort(byText),
    }));
}

/**
 * The trace as it stood at plant time `t`: records completed before `t` (with their lots,
 * operators and readings; units without one are left out), orders complete before `t`, cartons
 * in their state as of `t` (members placed and closings before it), the limit versions created
 * before `t` (one ended at or after `t` as still open), and the SPC points and episodes as they stand from the readings before it (an
 * episode still open at `t` stays open). Exit criterion 5 compares three projections through it.
 */
export function traceAsOf(trace: Trace, t: Millis): Trace {
  const units: UnitInput[] = trace.units
    .map(({ epoch, partId, serial, product, orderId, records }) => ({
      epoch,
      partId,
      serial,
      product,
      orderId,
      records: records.filter((r) => r.at < t),
    }))
    .filter((unit) => unit.records.length > 0);
  return buildTrace({
    config: trace.config,
    units,
    orders: trace.orders.map((order) => ({
      ...order,
      completedAt: order.completedAt !== null && order.completedAt < t ? order.completedAt : null,
    })),
    // A version ended at or after the cut was still open then.
    limits: trace.spc.limits
      .filter((v) => v.createdAt < t)
      .map((v) =>
        v.endedAt !== null && v.endedAt >= t ? { ...v, until: null, endedAt: null } : v,
      ),
  });
}

/** Backward: every unit with this serial, newest epoch first (serials repeat across runs, ADR-0034). */
export function backwardTrace(trace: Trace, serial: string): TraceUnit[] {
  return trace.units
    .filter((unit) => unit.serial === serial)
    .sort((a, b) => b.epoch - a.epoch || a.partId - b.partId);
}

export interface ForwardTrace {
  readonly lot: TraceLot;
  /** "Where used with": the other lots the same units consumed, by lot id. */
  readonly withLots: readonly LotRef[];
}

/** Forward: the lot's units, orders and cartons, and the other lots of those units. */
export function forwardTrace(trace: Trace, lotId: string): ForwardTrace | null {
  const lot = trace.lots.find((l) => l.lot === lotId);
  if (!lot) return null;
  const members = new Set(lot.units.map(unitId));
  const others = new Map<string, LotRef>();
  for (const unit of trace.units) {
    if (!members.has(unitId(unit))) continue;
    for (const record of unit.records) {
      for (const ref of record.lots) {
        if (ref.lot !== lotId) others.set(ref.lot, ref);
      }
    }
  }
  return {
    lot,
    withLots: [...others.values()].sort((a, b) => byText(a.lot, b.lot)),
  };
}
