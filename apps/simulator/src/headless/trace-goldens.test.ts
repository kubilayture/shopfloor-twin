/**
 * `trace.json` of every golden scenario (#208) against an independent reading of its event log:
 * every unit with its records, lots, operator, reading and carton (hashed as `unitsTraceSha256`),
 * every lot forward, and every carton's size. Plus the committed file is this run's, and the three
 * scenarios that existed before #208 keep their `summary.json` and `events.sha256` (the trace is a
 * sidecar, the summary schema stays `sim-summary/4`).
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scenarioNames, scenarioOptions } from './golden.ts';
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

interface Derived {
  units: TraceUnitJson[];
  lots: Map<string, { material: string; consumed: number; units: Set<number> }>;
}

/** Units, records and lots read from the event log alone, with the plan's rules restated. */
function derive(events: readonly LoggedEvent[]): Derived {
  const job = new Map<string, string>();
  const operator = new Map<string, string | null>();
  const pending = new Map<
    string,
    { lots: { material: string; lot: string }[]; op: string | null }
  >();
  const units = new Map<
    number,
    { serial: string; product: string; orderId: string | null; records: TraceRecordJson[] }
  >();
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
    if (e.type === 'job' && e.transition === 'started') job.set(machine, e.orderId as string);
    if (e.type === 'operator') operator.set(machine, (e.operatorId as string | null) ?? null);
    if (e.type === 'material-consumed') {
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
  // Cartons: per order, its good OP50 cycles in time order, `capacity` to a carton.
  const packed = new Map<string, number[]>();
  const sorted = [...units].sort(([a], [b]) => a - b);
  const packs = sorted
    .flatMap(([partId, u]) =>
      u.records
        .filter((r) => r.operation === 'OP50' && r.result === 'good' && u.orderId !== null)
        .map((r) => ({ partId, orderId: u.orderId ?? '', at: r.at })),
    )
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.partId - b.partId));
  const carton = new Map<number, string>();
  for (const pack of packs) {
    const list = packed.get(pack.orderId) ?? [];
    list.push(pack.partId);
    packed.set(pack.orderId, list);
    const product = units.get(pack.partId)?.product ?? '';
    const n = Math.floor((list.length - 1) / (CAPACITY[product] ?? 1)) + 1;
    carton.set(pack.partId, `${pack.orderId}-C${String(n).padStart(2, '0')}`);
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
  const lots = new Map<string, { material: string; consumed: number; units: Set<number> }>();
  for (const unit of list) {
    for (const record of unit.records) {
      for (const ref of record.lots) {
        const lot = lots.get(ref.lot) ?? { material: ref.material, consumed: 0, units: new Set() };
        lot.consumed++;
        lot.units.add(unit.partId);
        lots.set(ref.lot, lot);
      }
    }
  }
  return { units: list, lots };
}

interface TraceFile {
  schema: string;
  units: { count: number; unitsTraceSha256: string };
  lots: { lot: string; material: string; consumed: number; units: number[]; orders: string[] }[];
  cartons: {
    id: string;
    orderId: string;
    status: string;
    capacity: number;
    members: { count: number; sha256: string };
  }[];
  orders: { orderId: string; completedAt: string | null }[];
  spc: { readings: { firstPass: number } };
}

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
      const completed = new Set(
        trace.orders.filter((o) => o.completedAt !== null).map((o) => o.orderId),
      );
      const derived = derive(events);
      expect(trace.units).toEqual({
        count: derived.units.length,
        unitsTraceSha256: unitsTraceHash(derived.units),
      });
      expect(trace.lots.map((l) => [l.lot, l.material, l.consumed, l.units])).toEqual(
        [...derived.lots]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([lot, l]) => [lot, l.material, l.consumed, [...l.units].sort((a, b) => a - b)]),
      );
      // Cartons: full but the last of an order, which closes with the order or stays open.
      const byOrder = new Map<string, TraceFile['cartons']>();
      for (const c of trace.cartons) byOrder.set(c.orderId, [...(byOrder.get(c.orderId) ?? []), c]);
      for (const [orderId, cartons] of byOrder) {
        cartons.forEach((c, i) => {
          const last = i === cartons.length - 1;
          if (!last) expect(c.members.count, c.id).toBe(c.capacity);
          expect(c.status, c.id).toBe(
            !last || completed.has(orderId) || c.members.count === c.capacity ? 'closed' : 'open',
          );
          // In placement order: by the time of the unit's good OP50 cycle.
          const packedAt = (u: TraceUnitJson) =>
            u.records.find((r) => r.operation === 'OP50' && r.result === 'good')?.at ?? '';
          const members = derived.units
            .filter((u) => u.carton === c.id)
            .sort((a, b) => (packedAt(a) < packedAt(b) ? -1 : 1))
            .map((u) => u.partId);
          expect(c.members.sha256, c.id).toBe(
            createHash('sha256').update(stableStringify(members)).digest('hex'),
          );
        });
      }
      // Schedule mode has no orders, so no cartons; every unit of an orders run has an order.
      if (options.production === undefined) {
        expect(trace.cartons).toEqual([]);
        expect(derived.units.every((u) => u.orderId === null)).toBe(true);
      } else {
        expect(derived.units.every((u) => u.orderId !== null)).toBe(true);
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
