/**
 * `trace.json` of every golden scenario (#208) against an independent reading of its event log:
 * every unit with its records, lots, operator, reading and carton (hashed as `unitsTraceSha256`),
 * every lot forward (units, orders, cartons), every carton in full (order, product, members,
 * open or closed, closing time), the material booked per order and the quantities per operation
 * against the order truth, the material conservation, and the first-pass sequence and limit
 * version 1's statistics recomputed from the log. Plus the committed file is this run's, and the
 * three scenarios that existed before #208 keep their `summary.json` and `events.sha256` (the trace
 * is a sidecar, the summary schema stays `sim-summary/4`).
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scenarioNames, scenarioOptions } from './golden.ts';
import type { OrdersSummary } from './order-truth.ts';
import { runHeadless, summaryDocument, traceDocument } from './run.ts';
import { stableStringify } from './serialize.ts';
import { unitsTraceHash, type TraceRecordJson, type TraceUnitJson } from './trace-truth.ts';

const GOLDEN = resolve(import.meta.dirname, '../../golden');

type LoggedEvent = Record<string, unknown> & {
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

interface DerivedLot {
  material: string;
  consumed: number;
  units: Set<number>;
  orders: Set<string>;
  cartons: Set<string>;
}

interface DerivedCarton {
  id: string;
  orderId: string;
  product: string;
  capacity: number;
  status: 'open' | 'closed';
  closedAt: string | null;
  members: { count: number; sha256: string };
}

interface Derived {
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
function derive(events: readonly LoggedEvent[], orders: OrdersSummary): Derived {
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

/** The exact fraction num/den, reduced, as `trace.json` writes it. */
function fractionText(num: bigint, den: bigint): string {
  const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));
  const divisor = gcd(num < 0n ? -num : num, den);
  return `${String(num / divisor)}/${String(den / divisor)}`;
}

interface TraceFile {
  schema: string;
  units: { count: number; unitsTraceSha256: string };
  lots: {
    lot: string;
    material: string;
    consumed: number;
    units: number[];
    orders: string[];
    cartons: string[];
  }[];
  cartons: DerivedCarton[];
  orders: { orderId: string; completedAt: string | null }[];
  spc: {
    readings: { firstPass: number };
    limits: {
      limits: { statistics: { mean: string; movingRange: string; range: string } };
    }[];
  };
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

describe('trace.json of the golden scenarios (#208)', () => {
  it.each(scenarioNames())(
    '%s: equals an independent reading of its event log, and the committed file is this run',
    async (name) => {
      const options = await scenarioOptions(name);
      const lines: string[] = [];
      const result = runHeadless(options, (line) => lines.push(line));
      const committed = await readFile(resolve(GOLDEN, name, 'trace.json'), 'utf8');
      expect(traceDocument(result)).toBe(committed);
      const trace = JSON.parse(committed) as TraceFile;
      expect(trace.schema).toBe('sim-trace/1');
      const events = lines.slice(1).map((line) => JSON.parse(line) as LoggedEvent);
      const summary = result.summary.orders;
      const derived = derive(events, summary);

      // Units: every record with lots, operator, reading and carton.
      expect(trace.units).toEqual({
        count: derived.units.length,
        unitsTraceSha256: unitsTraceHash(derived.units),
      });
      // Lots forward: material, pieces, units, orders and cartons.
      expect(trace.lots).toEqual(
        [...derived.lots]
          .sort(([a], [b]) => byText(a, b))
          .map(([lot, l]) => ({
            lot,
            material: l.material,
            consumed: l.consumed,
            units: [...l.units].sort((a, b) => a - b),
            orders: [...l.orders].sort(byText),
            cartons: [...l.cartons].sort(byText),
          })),
      );
      // Cartons in full.
      const byId = (a: DerivedCarton, b: DerivedCarton) => byText(a.id, b.id);
      expect([...trace.cartons].sort(byId)).toEqual([...derived.cartons].sort(byId));

      // Per order: the material booked and the quantities per operation equal the order truth.
      for (const [orderId, order] of Object.entries(summary.orders)) {
        const records = derived.units
          .filter((u) => u.orderId === orderId)
          .flatMap((u) => u.records);
        const material: Record<string, number> = {};
        for (const ref of records.flatMap((r) => r.lots)) {
          material[ref.material] = (material[ref.material] ?? 0) + 1;
        }
        expect(material, orderId).toEqual(order.material);
        for (const [operation, quantities] of Object.entries(order.operations)) {
          const at = records.filter((r) => r.operation === operation);
          expect(quantities, `${orderId} ${operation}`).toEqual({
            in: at.length,
            good: at.filter((r) => r.result === 'good').length,
            scrap: at.filter((r) => r.result === 'scrap').length,
            rework: at.filter((r) => r.result === 'rework').length,
          });
        }
      }
      // Material conservation: pieces on records + pieces taken for cycles still running = every
      // material-consumed line; in orders mode the latter is the order truth's materialInProcess.
      const consumed = trace.lots.reduce((sum, lot) => sum + lot.consumed, 0);
      expect(consumed + derived.inProcess).toBe(derived.consumedLines);
      if (options.production !== undefined) {
        const inProcess = Object.values(summary.orders)
          .flatMap((o) => Object.values(o.materialInProcess))
          .reduce((sum, n) => sum + n, 0);
        expect(inProcess).toBe(derived.inProcess);
      }

      // SPC: the first-pass sequence and limit version 1's statistics, recomputed from the log.
      const firstPass = derived.units
        .flatMap((u) =>
          u.records
            .filter((r) => r.operation === 'OP40' && r.pass === 1 && r.reading !== null)
            .map((r) => ({ key: `0/${String(u.partId)}/1`, at: r.at, value: r.reading ?? 0 })),
        )
        .sort((a, b) => byText(a.at, b.at));
      expect(result.trace.trace.spc.chart.firstPass.map((r) => r.key)).toEqual(
        firstPass.map((r) => r.key),
      );
      const baseline = firstPass.slice(0, 100).map((r) => BigInt(r.value));
      expect(baseline).toHaveLength(100);
      const sum = (values: readonly bigint[]) => values.reduce((a, b) => a + b, 0n);
      const ranges = baseline
        .slice(1)
        .map((v, i) =>
          v > (baseline[i] ?? 0n) ? v - (baseline[i] ?? 0n) : (baseline[i] ?? 0n) - v,
        );
      const subgroupRanges = Array.from({ length: 20 }, (_, g) => {
        const group = baseline.slice(g * 5, g * 5 + 5);
        return group.reduce((a, b) => (b > a ? b : a)) - group.reduce((a, b) => (b < a ? b : a));
      });
      expect(trace.spc.limits[0]?.limits.statistics).toMatchObject({
        mean: fractionText(sum(baseline), 100n),
        movingRange: fractionText(sum(ranges), 99n),
        range: fractionText(sum(subgroupRanges), 20n),
      });

      // Schedule mode has no orders, so no cartons; every unit of an orders run has an order.
      if (options.production === undefined) {
        expect(trace.cartons).toEqual([]);
        expect(derived.units.every((u) => u.orderId === null)).toBe(true);
      } else {
        expect(derived.units.every((u) => u.orderId !== null)).toBe(true);
        expect(trace.cartons.length).toBeGreaterThan(0);
      }
      expect(trace.spc.readings.firstPass).toBeGreaterThan(300);
      // The summary is untouched by the trace: still sim-summary/4, byte for byte the committed one.
      expect(summaryDocument(result)).toBe(
        await readFile(resolve(GOLDEN, name, 'summary.json'), 'utf8'),
      );
    },
    120_000,
  );

  it('keeps the event logs of the scenarios before #208', async () => {
    const pinned: Record<string, string> = {
      'week-01': 'e7c6973678bbda868839fb35850b1475072b561fd89cc286a4f0827c009b740b  35764 lines\n',
      'alarms-01': '45e645695250f957742e50fed2c7af8131f831a158eded4aac2d7b6b9f4ab66a  5332 lines\n',
      'orders-01': 'ebd1e4aaf49f74ddca14f7b3a4767ade51627cf388d32ece86bcb4ac602aa893  6622 lines\n',
    };
    for (const [name, digest] of Object.entries(pinned)) {
      expect(await readFile(resolve(GOLDEN, name, 'events.sha256'), 'utf8'), name).toBe(digest);
    }
  });
});
