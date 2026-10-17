/**
 * An independent reading of a headless event log for the trace tests (#208): units with their
 * records, lots, operators, readings and cartons, lots forward and cartons in full, restating the
 * plan's rules without `trace-core`. Only an order's completion time comes from the order truth.
 */
import { createHash } from 'node:crypto';
import type { OrdersSummary } from './order-truth.ts';
import { stableStringify } from './serialize.ts';
import type { TraceRecordJson, TraceUnitJson } from './trace-truth.ts';

export type LoggedEvent = Record<string, unknown> & {
  readonly type: string;
  readonly at: string;
  readonly machineId?: string;
  readonly partId?: number;
};

const OPERATION: Record<string, string> = {
  'cnc-01': 'OP10',
  'cnc-02': 'OP10',
  'wsh-01': 'OP20',
  'asm-01': 'OP30',
  'lkt-01': 'OP40',
  'pck-01': 'OP50',
};
const CAPACITY: Record<string, number> = { 'VB-100': 20, 'VB-200': 12 };

const sha256 = (value: unknown): string =>
  createHash('sha256').update(stableStringify(value)).digest('hex');

export interface DerivedLot {
  material: string;
  consumed: number;
  units: Set<number>;
  orders: Set<string>;
  cartons: Set<string>;
}

export interface DerivedCarton {
  id: string;
  orderId: string;
  product: string;
  capacity: number;
  status: 'open' | 'closed';
  closedAt: string | null;
  members: { count: number; sha256: string };
}

export interface Derived {
  units: TraceUnitJson[];
  lots: Map<string, DerivedLot>;
  cartons: DerivedCarton[];
  /** `material-consumed` lines whose cycle never completed. */
  inProcess: number;
  consumedLines: number;
}

/**
 * Units, records, lots and cartons read from the event log alone, with the plan's rules restated;
 * only an order's completion time comes from the order truth (`summary.orders`, reconciled in
 * Phase 7), because it rests on the line's WIP at the end.
 */
export function derive(events: readonly LoggedEvent[], orders: OrdersSummary): Derived {
  const job = new Map<string, string>();
  const productOf = new Map<string, string>();
  const operator = new Map<string, string | null>();
  const pending = new Map<
    string,
    { lots: { material: string; lot: string }[]; op: string | null }
  >();
  const units = new Map<
    number,
    { serial: string; product: string; orderId: string | null; records: TraceRecordJson[] }
  >();
  let consumedLines = 0;
  const unitOf = (machine: string, partId: number) => {
    let unit = units.get(partId);
    if (!unit) {
      unit = {
        serial: '',
        product: '',
        orderId: OPERATION[machine] === 'OP10' ? (job.get(machine) ?? null) : null,
        records: [],
      };
      units.set(partId, unit);
    }
    return unit;
  };
  for (const e of events) {
    const machine = e.machineId ?? '';
    const partId = e.partId ?? 0;
    if (e.type === 'job') productOf.set(e.orderId as string, e.product as string);
    if (e.type === 'job' && e.transition === 'started') job.set(machine, e.orderId as string);
    if (e.type === 'operator') operator.set(machine, (e.operatorId as string | null) ?? null);
    if (e.type === 'material-consumed') {
      consumedLines++;
      unitOf(machine, partId);
      const key = `${machine}/${String(partId)}`;
      const entry = pending.get(key) ?? { lots: [], op: operator.get(machine) ?? null };
      entry.lots.push({ material: e.material as string, lot: e.lotId as string });
      pending.set(key, entry);
    }
    if (e.type !== 'cycle-complete') continue;
    const unit = unitOf(machine, partId);
    unit.product = e.product as string;
    if (e.serial !== '') unit.serial = e.serial as string;
    const op = OPERATION[machine] ?? '';
    const reworks = unit.records.filter((r) => r.result === 'rework').length;
    const key = `${machine}/${String(partId)}`;
    const taken = pending.get(key);
    pending.delete(key);
    const measurement = e.measurement as { value: number } | undefined;
    unit.records.push({
      operation: op,
      pass: op === 'OP30' || op === 'OP40' ? reworks + 1 : 1,
      machine,
      at: e.at,
      result: e.result as TraceRecordJson['result'],
      reason: (e.reason as string | undefined) ?? null,
      lots: taken?.lots ?? [],
      operator: taken?.op ?? null,
      reading: measurement === undefined ? null : Math.round(measurement.value * 1000),
    });
  }
  // Cartons: per order, its good OP50 cycles in time order, `capacity` to a carton; a full carton
  // closes at its capacity-th member, the last one with the order (or stays open).
  const sorted = [...units].sort(([a], [b]) => a - b);
  const packs = sorted
    .flatMap(([partId, u]) =>
      u.records
        .filter((r) => r.operation === 'OP50' && r.result === 'good' && u.orderId !== null)
        .map((r) => ({ partId, orderId: u.orderId ?? '', at: r.at })),
    )
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.partId - b.partId));
  const byOrder = new Map<string, { partId: number; at: string }[]>();
  for (const pack of packs) {
    byOrder.set(pack.orderId, [...(byOrder.get(pack.orderId) ?? []), pack]);
  }
  const carton = new Map<number, string>();
  const cartons: DerivedCarton[] = [];
  for (const [orderId, list] of byOrder) {
    const product = productOf.get(orderId) ?? '';
    const capacity = CAPACITY[product] ?? 1;
    for (let start = 0; start < list.length; start += capacity) {
      const members = list.slice(start, start + capacity);
      const id = `${orderId}-C${String(start / capacity + 1).padStart(2, '0')}`;
      for (const member of members) carton.set(member.partId, id);
      const closedAt =
        members.length === capacity
          ? (members.at(-1)?.at ?? null)
          : (orders.orders[orderId]?.completedAt ?? null);
      cartons.push({
        id,
        orderId,
        product,
        capacity,
        status: closedAt === null ? 'open' : 'closed',
        closedAt,
        members: { count: members.length, sha256: sha256(members.map((m) => m.partId)) },
      });
    }
  }
  const list: TraceUnitJson[] = sorted
    .filter(([, u]) => u.records.length > 0)
    .map(([partId, u]) => ({
      partId,
      serial: u.serial,
      product: u.product,
      orderId: u.orderId,
      status: u.records.some((r) => r.result === 'scrap')
        ? 'scrapped'
        : u.records.some((r) => r.operation === 'OP50' && r.result === 'good')
          ? 'packed'
          : 'wip',
      carton: carton.get(partId) ?? null,
      records: u.records,
    }));
  const lots = new Map<string, DerivedLot>();
  for (const unit of list) {
    for (const record of unit.records) {
      for (const ref of record.lots) {
        const lot = lots.get(ref.lot) ?? {
          material: ref.material,
          consumed: 0,
          units: new Set<number>(),
          orders: new Set<string>(),
          cartons: new Set<string>(),
        };
        lot.consumed++;
        lot.units.add(unit.partId);
        if (unit.orderId !== null) lot.orders.add(unit.orderId);
        if (unit.carton !== null) lot.cartons.add(unit.carton);
        lots.set(ref.lot, lot);
      }
    }
  }
  const inProcess = [...pending.values()].reduce((sum, entry) => sum + entry.lots.length, 0);
  return { units: list, lots, cartons, inProcess, consumedLines };
}
