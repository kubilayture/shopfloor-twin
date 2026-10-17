/**
 * Test support: the genealogy reconciliation with the simulator's trace ground truth (#199, Phase
 * 8 plan "Ground truth and reconciliation", exit criteria 1 and 2 without the broker).
 *
 * - The expected trace is derived here from the event log alone (units by `partId`, their order by
 *   the job facts, passes by leak-test reworks, lots and operators by ADR-0033's rule written out
 *   over the raw `material-consumed` and `operator` events, readings in resolution steps), and
 *   built into the trace tree by `trace-core`'s `buildTrace` with the orders' completion from
 *   `trace.json`: the shared definitions of cartons and lots (ADR-0034). Its units hash to
 *   `trace.json`'s `unitsTraceSha256`, its lots and cartons equal `trace.json`'s, so the derivation
 *   is the truth's.
 * - The MES side is read as the e2e reads it through the API: a forward trace of every lot of the
 *   ERP's lot list, then a backward trace of every serial those return; cartons with their
 *   members. Both are mapped to `trace.json`'s shapes and compared in full.
 * - `traceAsOf` (trace-core) cuts the expected trace at a plant time, for a comparison while the
 *   facts after it have not arrived yet.
 */
import { createHash } from 'node:crypto';
import type { PlantConfig } from '@shopfloor/plant-config';
import {
  buildTrace,
  traceAsOf,
  type OrderPacking,
  type Trace,
  type TraceConfig,
  type TraceRecord,
  type UnitInput,
} from '@shopfloor/trace-core';
import { expect } from 'vitest';
import type { Genealogy } from '../genealogy/index.ts';
import { lotTraceDto, serialTraceDto } from '../realtime/index.ts';

/** The fields of a simulator event the derivation reads. */
export interface TraceEvent {
  readonly type: string;
  readonly at: string;
  readonly machineId?: string;
  readonly product?: string;
  readonly partId?: number;
  readonly serial?: string;
  readonly result?: 'good' | 'scrap' | 'rework';
  readonly reason?: string;
  readonly measurement?: { readonly value: number };
  readonly transition?: string;
  readonly commandId?: string;
  readonly orderId?: string;
  readonly material?: string;
  readonly lotId?: string;
  readonly operatorId?: string | null;
}

/** `trace.json` (`sim-trace/1`) as far as genealogy reconciles it. */
export interface TraceJson {
  readonly units: { readonly count: number; readonly unitsTraceSha256: string };
  readonly orders: readonly {
    readonly orderId: string;
    readonly product: string;
    readonly completedAt: string | null;
  }[];
  readonly lots: readonly LotJson[];
  readonly cartons: readonly {
    readonly id: string;
    readonly orderId: string;
    readonly product: string;
    readonly capacity: number;
    readonly status: 'open' | 'closed';
    readonly closedAt: string | null;
    readonly members: { readonly count: number; readonly sha256: string };
  }[];
}

export interface LotJson {
  readonly lot: string;
  readonly material: string;
  readonly consumed: number;
  readonly units: readonly number[];
  readonly orders: readonly string[];
  readonly cartons: readonly string[];
}

/** A unit as `unitsTraceSha256` hashes it (the simulator's `traceUnits`). */
export interface UnitJson {
  readonly partId: number;
  readonly serial: string;
  readonly product: string;
  readonly orderId: string | null;
  readonly status: 'wip' | 'scrapped' | 'packed';
  readonly carton: string | null;
  readonly records: readonly {
    readonly operation: string;
    readonly pass: number;
    readonly machine: string;
    readonly at: string;
    readonly result: 'good' | 'scrap' | 'rework';
    readonly reason: string | null;
    readonly lots: readonly { readonly material: string; readonly lot: string }[];
    readonly operator: string | null;
    readonly reading: number | null;
  }[];
}

/** A carton with its members' part ids in placement order. */
export interface CartonJson {
  readonly id: string;
  readonly orderId: string;
  readonly product: string;
  readonly capacity: number;
  readonly status: 'open' | 'closed';
  readonly closedAt: string | null;
  readonly members: readonly number[];
}

/** The genealogy as compared: units, consumed lots and cartons. */
export interface TraceProjection {
  readonly units: UnitJson[];
  readonly lots: LotJson[];
  readonly cartons: CartonJson[];
}

/** Device facts: every one takes the machine's next sequence number. */
const DEVICE_FACTS = new Set(['state', 'cycle-complete', 'alarm', 'job']);

/** Canonical JSON, keys sorted (the simulator's `stableStringify`; apps never import each other). */
export function canonicalJson(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item !== null && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, canonical(v)]),
      );
    }
    return item;
  };
  return JSON.stringify(canonical(value));
}

const sha256 = (value: unknown): string =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');

/** The trace configuration the MES reads (`packing.yaml`, `quality.yaml`), as the truth's. */
export function traceConfig(plant: PlantConfig): TraceConfig {
  const operation = plant.process.leakTest.operation;
  const characteristic = plant.quality.characteristics.find((c) => c.operation === operation);
  if (!characteristic) throw new Error('quality.yaml has no leak-test characteristic');
  return {
    packOperation: plant.packing.operation,
    capacity: { ...plant.packing.capacity },
    spc: {
      characteristic: characteristic.id,
      operation: characteristic.operation,
      subgroupSize: characteristic.subgroupSize,
      baselineSubgroups: characteristic.baselineSubgroups,
      rules: characteristic.rules as TraceConfig['spc']['rules'],
    },
  };
}

/**
 * The trace of a run from its event log alone (see the file's comment): every part with a record,
 * keyed (epoch, partId) in the MES's epoch; lots and operator per cycle written out from the raw
 * events (a part's `material-consumed` events on a machine attach, in order, to its next cycle
 * there; the operator is the machine's latest `operator` event before the part's first
 * consumption there; none: `[]` and null); orders by the CNC's latest `started` job when the part's
 * blank was taken (none in schedule mode).
 */
export function eventLogTrace(
  events: readonly TraceEvent[],
  plant: PlantConfig,
  orders: TraceJson['orders'],
  epoch: number,
): Trace {
  const config = traceConfig(plant);
  const operationOf = new Map<string, string>();
  for (const area of plant.plant.areas) {
    for (const wc of area.workCenters) {
      for (const item of wc.equipment) operationOf.set(item.id, item.operation);
    }
  }
  const first = plant.products.operations[0] ?? 'OP10';
  const resolution = plant.process.leakTest.resolution;
  const reworkOps = new Set([
    plant.process.leakTest.operation,
    plant.process.leakTest.reworkOperation,
  ]);
  const seqs = new Map<string, number>();
  const current = new Map<string, string>();
  const operators = new Map<string, string | null>();
  const pending = new Map<
    string,
    { lots: { material: string; lot: string }[]; operator: string | null }
  >();
  const units = new Map<
    number,
    {
      serial: string;
      product: string;
      orderId: string | null;
      records: TraceRecord[];
      reworks: number;
    }
  >();
  const unitOf = (machine: string, partId: number, product: string) => {
    let unit = units.get(partId);
    if (!unit) {
      unit = {
        serial: '',
        product,
        orderId: operationOf.get(machine) === first ? (current.get(machine) ?? null) : null,
        records: [],
        reworks: 0,
      };
      units.set(partId, unit);
    }
    if (product !== '') unit.product = product;
    return unit;
  };
  for (const event of events) {
    const machine = event.machineId ?? '';
    let seq = 0;
    if (DEVICE_FACTS.has(event.type) && machine !== '') {
      seq = (seqs.get(machine) ?? 0) + 1;
      seqs.set(machine, seq);
    }
    if (event.type === 'job' && event.transition === 'started') {
      current.set(machine, event.orderId ?? '');
    } else if (event.type === 'operator') {
      operators.set(machine, event.operatorId ?? null);
    } else if (event.type === 'material-consumed') {
      unitOf(machine, event.partId ?? 0, '');
      const key = `${machine}/${String(event.partId)}`;
      let entry = pending.get(key);
      if (!entry) {
        entry = { lots: [], operator: operators.get(machine) ?? null };
        pending.set(key, entry);
      }
      entry.lots.push({ material: event.material ?? '', lot: event.lotId ?? '' });
    } else if (event.type === 'cycle-complete') {
      const operation = operationOf.get(machine);
      if (operation === undefined) throw new Error(`cycle on unknown machine ${machine}`);
      const unit = unitOf(machine, event.partId ?? 0, event.product ?? '');
      if (event.serial !== undefined && event.serial !== '') unit.serial = event.serial;
      const key = `${machine}/${String(event.partId)}`;
      const attached = pending.get(key) ?? { lots: [], operator: null };
      pending.delete(key);
      const pass = reworkOps.has(operation) ? unit.reworks + 1 : 1;
      unit.records.push({
        operation,
        pass,
        machine,
        at: Date.parse(event.at),
        seq,
        result: event.result ?? 'good',
        reason: event.reason ?? null,
        lots: attached.lots,
        operator: attached.operator,
        reading:
          event.measurement !== undefined && operation === config.spc.operation
            ? Math.round(event.measurement.value / resolution)
            : null,
      });
      if (event.result === 'rework') unit.reworks++;
    }
  }
  const inputs: UnitInput[] = [...units]
    .filter(([, unit]) => unit.records.length > 0)
    .map(([partId, unit]) => ({
      epoch,
      partId,
      serial: unit.serial,
      product: unit.product,
      orderId: unit.orderId,
      records: unit.records,
    }));
  const packing: OrderPacking[] = orders.map((o) => ({
    orderId: o.orderId,
    product: o.product,
    completedAt: o.completedAt === null ? null : Date.parse(o.completedAt),
  }));
  return buildTrace({ config, units: inputs, orders: packing });
}

/** A trace in the shapes compared: `trace.json`'s units and lots, cartons with their members. */
export function projection(trace: Trace): TraceProjection {
  return {
    units: trace.units.map((unit) => ({
      partId: unit.partId,
      serial: unit.serial,
      product: unit.product,
      orderId: unit.orderId,
      status: unit.status,
      carton: unit.carton,
      records: unit.records.map((r) => ({
        operation: r.operation,
        pass: r.pass,
        machine: r.machine,
        at: new Date(r.at).toISOString(),
        result: r.result,
        reason: r.reason,
        lots: r.lots.map((l) => ({ material: l.material, lot: l.lot })),
        operator: r.operator,
        reading: r.reading,
      })),
    })),
    lots: trace.lots.map((lot) => ({
      lot: lot.lot,
      material: lot.material,
      consumed: lot.consumed,
      units: lot.units.map((u) => u.partId),
      orders: [...lot.orders],
      cartons: [...lot.cartons],
    })),
    cartons: trace.cartons.map((c) => ({
      id: c.id,
      orderId: c.orderId,
      product: c.product,
      capacity: c.capacity,
      status: c.status,
      closedAt: c.closedAt === null ? null : new Date(c.closedAt).toISOString(),
      members: c.members.map((m) => m.partId),
    })),
  };
}

/** The derived projection is the truth's: `unitsTraceSha256` and count, lots, carton digests. */
export function expectTruth(expected: TraceProjection, truth: TraceJson): void {
  expect(expected.units).toHaveLength(truth.units.count);
  expect(sha256(expected.units)).toBe(truth.units.unitsTraceSha256);
  expect(expected.lots).toEqual(truth.lots);
  expect(
    expected.cartons.map(({ members, ...carton }) => ({
      ...carton,
      members: { count: members.length, sha256: sha256(members) },
    })),
  ).toEqual(truth.cartons);
}

/** What a reading is in resolution steps, as the truth records it. */
export interface ReadingScale {
  readonly operation: string;
  readonly resolution: number;
  /** Machines that report no lots (Modbus): their records' "not reported" counts as none. */
  readonly modbus: ReadonlySet<string>;
}

/**
 * The MES's genealogy in the compared shapes, read as the API answers (the route DTOs): a forward
 * trace of every lot of the ERP's lot list, a backward trace of every serial they return, and the
 * cartons with their members. Lots the ERP lists but nothing consumed are left out (the truth
 * lists consumed lots only), after checking they answer with no unit. Also each serial trace's
 * `final` and the latest record time it was judged at.
 */
export async function mesProjection(
  genealogy: Genealogy,
  scale: ReadingScale,
): Promise<TraceProjection & { finals: { latest: number; final: boolean }[] }> {
  const lots: LotJson[] = [];
  const serials = new Set<string>();
  for (const lot of await genealogy.lots()) {
    const found = await genealogy.lot(lot.id);
    if (!found) throw new Error(`no forward trace of ${lot.id}`);
    const dto = lotTraceDto(found);
    expect(dto.truncated).toBe(false);
    if (dto.units.length === 0) {
      expect([lot.id, dto.consumed, dto.orders, dto.cartons]).toEqual([lot.id, 0, [], []]);
      continue;
    }
    lots.push({
      lot: dto.lot,
      material: dto.material,
      consumed: dto.consumed,
      units: dto.units.map((u) => u.partId),
      orders: dto.orders,
      cartons: dto.cartons,
    });
    for (const unit of dto.units) {
      if (unit.serial === null) throw new Error(`unit ${String(unit.partId)} has no serial`);
      serials.add(unit.serial);
    }
  }
  const units: UnitJson[] = [];
  const finals: { latest: number; final: boolean }[] = [];
  for (const serial of serials) {
    const found = await genealogy.serial(serial);
    if (!found) throw new Error(`no backward trace of ${serial}`);
    const dto = serialTraceDto(found);
    finals.push({
      latest: Math.max(...dto.units.flatMap((u) => u.records.map((r) => Date.parse(r.at)))),
      final: dto.final,
    });
    for (const unit of dto.units) {
      units.push({
        partId: unit.partId,
        serial: unit.serial ?? '',
        product: unit.product,
        orderId: unit.orderId,
        status: unit.status === 'lost' ? 'wip' : unit.status,
        carton: unit.carton,
        records: unit.records.map((r) => {
          // Absent lots are "not reported": only a Modbus machine may report none.
          if (r.lots === null)
            expect([r.equipment, scale.modbus.has(r.equipment)]).toEqual([r.equipment, true]);
          return {
            operation: r.operation,
            pass: r.pass,
            machine: r.equipment,
            at: r.at,
            result: r.result,
            reason: r.reason,
            lots: r.lots ?? [],
            operator: r.operator,
            reading:
              r.reading !== null && r.operation === scale.operation
                ? Math.round(r.reading.value / scale.resolution)
                : null,
          };
        }),
      });
    }
  }
  units.sort((a, b) => a.partId - b.partId);
  lots.sort((a, b) => (a.lot < b.lot ? -1 : a.lot > b.lot ? 1 : 0));
  const members = await genealogy.cartonMembers();
  const cartons: CartonJson[] = (await genealogy.cartons()).map((c) => ({
    id: c.id,
    orderId: c.orderId,
    product: c.product,
    capacity: c.capacity,
    status: c.status,
    closedAt: c.closedAt === null ? null : c.closedAt.toISOString(),
    members: (members.get(c.id) ?? []).map((m) => m.partId),
  }));
  return { units, lots, cartons, finals };
}

/** The expected projection at a time cut (`trace-core`'s `traceAsOf`). */
export const projectionAsOf = (trace: Trace, at: number): TraceProjection =>
  projection(traceAsOf(trace, at));

/**
 * The cartons in the truth's order: by order as `trace.json` lists them, keeping their number
 * order within an order (the MES lists them by order and number; a stable sort).
 */
export function sortCartons(
  cartons: readonly CartonJson[],
  orders: TraceJson['orders'],
): CartonJson[] {
  const rank = new Map(orders.map((o, i) => [o.orderId, i]));
  return [...cartons].sort(
    (a, b) =>
      (rank.get(a.orderId) ?? Number.MAX_SAFE_INTEGER) -
      (rank.get(b.orderId) ?? Number.MAX_SAFE_INTEGER),
  );
}

/**
 * `quality-01`'s required features (plan "Golden scenario quality-01", exit criterion 2), found in
 * the MES's genealogy: a carton (so an order) with units of two blank lots; a component lot that
 * changes inside an order and one used by two orders; a reworked unit whose rework pass took a
 * seal kit of another lot than its first pass; a leak scrap; a short order's partial carton,
 * closed; a unit still in WIP.
 */
export function expectQualityFeatures(
  actual: TraceProjection,
  blank: (material: string) => boolean,
): void {
  const units = new Map(actual.units.map((u) => [u.partId, u]));
  const lotsAt = (
    partId: number,
    operation: string,
    pass: number,
  ): { material: string; lot: string }[] =>
    units
      .get(partId)
      ?.records.filter((r) => r.operation === operation && r.pass === pass)
      .flatMap((r) => r.lots) ?? [];
  const blankLots = (members: readonly number[]) =>
    new Set(
      members.flatMap((m) =>
        lotsAt(m, 'OP10', 1)
          .filter((l) => blank(l.material))
          .map((l) => l.lot),
      ),
    );
  expect(actual.cartons.some((c) => blankLots(c.members).size >= 2)).toBe(true);
  const components = actual.lots.filter((l) => !blank(l.material));
  expect(components.some((l) => l.orders.length >= 2)).toBe(true);
  const perOrder = new Map<string, Set<string>>();
  for (const unit of actual.units) {
    if (unit.orderId === null) continue;
    for (const lot of lotsAt(unit.partId, 'OP30', 1)) {
      const key = `${unit.orderId}/${lot.material}`;
      perOrder.set(key, (perOrder.get(key) ?? new Set()).add(lot.lot));
    }
  }
  expect([...perOrder.values()].some((lots) => lots.size >= 2)).toBe(true);
  expect(
    actual.units.some((u) => {
      const second = lotsAt(u.partId, 'OP30', 2);
      const first = lotsAt(u.partId, 'OP30', 1);
      return second.some((l) => first.some((f) => f.material === l.material && f.lot !== l.lot));
    }),
  ).toBe(true);
  expect(
    actual.units.some((u) =>
      u.records.some((r) => r.operation === 'OP40' && r.result === 'scrap' && r.reason === 'LEAK'),
    ),
  ).toBe(true);
  expect(actual.cartons.some((c) => c.status === 'closed' && c.members.length < c.capacity)).toBe(
    true,
  );
  expect(actual.units.some((u) => u.status === 'wip')).toBe(true);
}
