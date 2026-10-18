/**
 * `line-oee.json` (#230, P9-03) of every golden scenario: the committed file is this run's; the
 * summary, trace and event log stay byte-identical; good packed per hour, head times, in-progress
 * time, completion and blanks agree with an independent reading of the event log and with the order
 * truth; hours add up to their shifts; and hand-checked values from `orders-01` and `week-01`.
 * Beside it, synthetic runs for planned maintenance on the bottleneck, a provisional cut and the
 * `asOf` cut of a section.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { PlantConfig } from '@shopfloor/plant-config';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PlantEvent } from '../plant/line.ts';
import { loadDefaultConfig } from '../plant/testing.ts';
import { scenarioNames, scenarioOptions } from './golden.ts';
import { LineOeeTruth, type LineOeeSection, type LineValueJson } from './line-oee-truth.ts';
import { lineOeeDocument, runHeadless, summaryDocument, traceDocument } from './run.ts';

const GOLDEN = resolve(import.meta.dirname, '../../golden');
const HOUR = 3_600_000;

interface LoggedEvent {
  readonly type: string;
  readonly at: string;
  readonly machineId?: string;
  readonly result?: string;
  readonly product?: string;
  readonly transition?: string;
  readonly commandId?: string;
  readonly orderId?: string;
  readonly partId?: number;
}

/** Σ of `num/den` strings whose denominators are 1 here (the bottleneck has one machine). */
const sumIdeal = (values: readonly LineValueJson[]): bigint =>
  values.reduce((sum, v) => {
    const [num, den] = v.idealMs.split('/');
    expect(den).toBe('1');
    return sum + BigInt(num ?? '0');
  }, 0n);

describe('line-oee.json of the golden scenarios (#230)', () => {
  it.each(scenarioNames())(
    '%s: is this run, keeps the other files, and agrees with its event log',
    async (name) => {
      const options = await scenarioOptions(name);
      const hash = createHash('sha256');
      const lines: string[] = [];
      const result = runHeadless(options, (line) => {
        hash.update(`${line}\n`);
        lines.push(line);
      });
      const read = (file: string) => readFile(resolve(GOLDEN, name, file), 'utf8');
      expect(lineOeeDocument(result)).toBe(await read('line-oee.json'));
      // A sidecar: the summary, the trace and the event log are byte for byte the committed ones.
      expect(summaryDocument(result)).toBe(await read('summary.json'));
      expect(traceDocument(result)).toBe(await read('trace.json'));
      expect(`${hash.digest('hex')}  ${String(lines.length)} lines\n`).toBe(
        await read('events.sha256'),
      );

      const doc = JSON.parse(await read('line-oee.json')) as LineOeeSection & { schema: string };
      expect(doc.schema).toBe('sim-line-oee/1');
      expect(doc.analysisConfigSha256).toBe(result.analysisConfigSha256);
      expect(doc.bottlenecks).toEqual({
        'VB-100': {
          operation: 'OP30',
          equipment: ['asm-01'],
          idealCycleMs: 150_000,
          effectiveCycleMs: '150000/1',
        },
        'VB-200': {
          operation: 'OP30',
          equipment: ['asm-01'],
          idealCycleMs: 210_000,
          effectiveCycleMs: '210000/1',
        },
      });
      // ASM-01 never goes to Maintenance: the planned stops are the calendar's breaks.
      expect(doc.plannedStops.every((stop) => stop.kind === 'break')).toBe(true);
      expect(
        doc.plannedStops.every((s) => Date.parse(s.to) - Date.parse(s.from) === 30 * 60_000),
      ).toBe(true);

      const events = lines.slice(1).map((line) => JSON.parse(line) as LoggedEvent);
      // Good packed per UTC hour from the log: PCK-01's good cycles.
      const packed = new Map<string, Record<string, number>>();
      for (const e of events) {
        if (e.type !== 'cycle-complete' || e.machineId !== 'pck-01' || e.result !== 'good') {
          continue;
        }
        const hour = new Date(Math.floor(Date.parse(e.at) / HOUR) * HOUR).toISOString();
        const perProduct = packed.get(hour) ?? {};
        perProduct[e.product ?? ''] = (perProduct[e.product ?? ''] ?? 0) + 1;
        packed.set(hour, perProduct);
      }
      const hours = doc.line.hours;
      expect(Object.keys(hours)).toHaveLength((options.end - options.start) / HOUR);
      for (const [hour, value] of Object.entries(hours)) {
        expect(value.good, hour).toEqual(packed.get(hour) ?? {});
        expect(value.provisional).toBe(false);
      }
      // Hours add up to their shifts: planned busy time and ideal time (ADR-0036's property).
      const shifts = Object.values(doc.line.shifts);
      const total = (values: readonly LineValueJson[]) =>
        values.reduce((sum, v) => sum + v.plannedBusyMs, 0);
      expect(total(Object.values(hours))).toBe(total(shifts));
      expect(sumIdeal(Object.values(hours))).toBe(sumIdeal(shifts));
      expect(shifts.every((s) => !s.provisional)).toBe(true);

      if (options.production === undefined) {
        // Schedule mode: every shift is planned but its break, and there are no orders.
        expect(shifts.map((s) => s.plannedBusyMs)).toEqual(shifts.map(() => 27_000_000));
        expect(doc.inProgress).toEqual([]);
        expect(doc.orders).toEqual({});
        return;
      }

      // Orders mode: head times from the job lines, max(accepted, previous completed) per CNC.
      const queues = new Map<string, { id: string; accepted: number; completed?: number }[]>();
      const byId = new Map<string, { id: string; accepted: number; completed?: number }>();
      const orderOf = new Map<string, string>();
      for (const e of events) {
        if (e.type !== 'job' || e.commandId === undefined) continue;
        if (e.transition === 'accepted') {
          const job = { id: e.commandId, accepted: Date.parse(e.at) };
          byId.set(job.id, job);
          orderOf.set(job.id, e.orderId ?? '');
          queues.set(e.machineId ?? '', [...(queues.get(e.machineId ?? '') ?? []), job]);
        } else if (e.transition === 'completed') {
          const job = byId.get(e.commandId);
          if (job) job.completed = Date.parse(e.at);
        }
      }
      const head = new Map<string, number>();
      for (const queue of queues.values()) {
        queue.forEach((job, i) => {
          const previous = queue[i - 1];
          if (previous === undefined) head.set(job.id, job.accepted);
          else if (previous.completed !== undefined) {
            head.set(job.id, Math.max(job.accepted, previous.completed));
          }
        });
      }
      // Each part's order by the started-fact rule, and each order's latest OP50 record.
      const currentJob = new Map<string, string>();
      const partOrder = new Map<number, string>();
      const lastPack = new Map<string, string>();
      for (const e of events) {
        if (e.type === 'job' && e.transition === 'started') {
          currentJob.set(e.machineId ?? '', e.commandId ?? '');
        } else if (e.type === 'cycle-complete' && e.partId !== undefined) {
          const job = currentJob.get(e.machineId ?? '');
          if (e.machineId?.startsWith('cnc-') && job !== undefined && !partOrder.has(e.partId)) {
            partOrder.set(e.partId, orderOf.get(job) ?? '');
          }
          const order = partOrder.get(e.partId);
          if (e.machineId === 'pck-01' && order !== undefined) lastPack.set(order, e.at);
        }
      }
      const truth = result.summary.orders;
      expect(Object.keys(doc.orders).sort()).toEqual(Object.keys(truth.orders).sort());
      for (const [orderId, order] of Object.entries(truth.orders)) {
        const entry = doc.orders[orderId];
        if (entry === undefined) throw new Error(`no ${orderId}`);
        expect(entry.completedAt, orderId).toBe(order.completedAt);
        // In the goldens the completion is the order's latest OP50 record.
        if (order.completedAt !== null)
          expect(lastPack.get(orderId), orderId).toBe(order.completedAt);
        expect(entry.firstPassYield.started, orderId).toBe(order.started);
        expect(entry.firstPassYield.firstPassGood).toBeLessThanOrEqual(order.packedGood);
        expect(entry.jobs).toEqual(order.jobs);
        // The order OEE counts every OP10 cycle of the order (scheduled or not).
        const op10 = entry.oee.totals.produced + entry.oee.unplanned.produced;
        expect(op10, orderId).toBe(order.operations.OP10?.in ?? 0);
        // Its line OEE packs its own good units over its in-progress time.
        const good = Object.values(entry.line?.good ?? {}).reduce((s, n) => s + n, 0);
        expect(good, orderId).toBe(order.packedGood);
        const heads = order.jobs.flatMap((id) => {
          const at = head.get(id);
          return at === undefined ? [] : [at];
        });
        const range = doc.inProgress.find((r) => r.orderId === orderId);
        expect(range, orderId).toEqual({
          orderId,
          from: new Date(Math.min(...heads)).toISOString(),
          to: order.completedAt ?? new Date(options.end).toISOString(),
          open: order.completedAt === null,
        });
        for (const id of order.jobs) {
          const job = entry.jobOee[id];
          expect(job?.headTime, id).toBe(new Date(head.get(id) ?? 0).toISOString());
          const facts = truth.jobs.find((j) => j.commandId === id);
          expect(job?.window, id).toEqual({
            from: job?.headTime,
            to: facts?.completedAt ?? new Date(options.end).toISOString(),
            open: facts?.completedAt === null,
          });
          if (facts?.completedAt !== null) expect(job?.cycles, id).toBe(facts?.quantity);
        }
        expect(entry.open).toBe(order.jobs.some((id) => entry.jobOee[id]?.window?.open));
        expect([entry.pending, entry.headTimeUnknown, entry.endLost, entry.lost]).toEqual([
          false,
          false,
          false,
          false,
        ]);
      }
    },
    120_000,
  );

  it('orders-01: hand-checked order PO-2610-001 and shift 2026-10-12/A', async () => {
    const doc = JSON.parse(
      await readFile(resolve(GOLDEN, 'orders-01', 'line-oee.json'), 'utf8'),
    ) as LineOeeSection;
    // PO-2610-001, 12 × VB-100 on CNC-01: accepted at 06:00 Istanbul (03:00Z, the head time),
    // changeover Setup 03:00–03:25, started 03:25, completed 04:13:44.974. Window 4 424 974 ms, no
    // break or Idle NO-ORDER in it: PBT 4 424 974, Setup 1 500 000, APT 2 924 974 (two CHIP-JAM
    // micro-stops of 8 708 and 17 897 ms inside). Ideal 12 × 240 000 = 2 880 000.
    // A = 2 924 974 / 4 424 974, P = 2 880 000 / 2 924 974, Q = 1, OEE = 2 880 000 / 4 424 974.
    const order = doc.orders['PO-2610-001'];
    expect(order?.oee.totals).toMatchObject({
      plannedBusyMs: 4_424_974,
      actualProductionMs: 2_924_974,
      microStopMs: 26_605,
      idealMs: 2_880_000,
      good: 12,
      produced: 12,
    });
    expect(order?.oee.losses?.availability.own.setup).toBe(1_500_000);
    expect(order?.oee.oee).toEqual({ fraction: '1440000/2212487', decimal: '0.6509' });
    // Its line OEE: 03:00Z to its last pack 04:32:11.237Z, inside shift A before the break:
    // 5 531 237 ms, 12 × 150 000 = 1 800 000 → 1 800 000 / 5 531 237 = 0.3254.
    expect(order?.line).toMatchObject({
      plannedBusyMs: 5_531_237,
      idealMs: '1800000/1',
      oee: { fraction: '1800000/5531237', decimal: '0.3254' },
    });
    // Shift A: an order is in progress all shift (from 03:00Z), so 8 h − the 30-min break;
    // 109 VB-100 and 18 VB-200 packed: (109 × 150 000 + 18 × 210 000) / 27 000 000 = 671/900.
    expect(doc.line.shifts['2026-10-12/A']).toMatchObject({
      plannedBusyMs: 27_000_000,
      good: { 'VB-100': 109, 'VB-200': 18 },
      idealMs: '20130000/1',
      oee: { fraction: '671/900', decimal: '0.7456' },
      aboveOne: false,
    });
  });

  it('week-01: hand-checked hour 10:00–11:00 Istanbul on Monday, above 1 after the break', async () => {
    const doc = JSON.parse(
      await readFile(resolve(GOLDEN, 'week-01', 'line-oee.json'), 'utf8'),
    ) as LineOeeSection;
    // The break 10:00–10:30 leaves 1 800 000 ms planned; PCK-01 packs 13 VB-100 between
    // 10:30:04 and 10:58:29 from the buffers filled during the break: 13 × 150 000 = 1 950 000,
    // 13/12 = 1.0833, flagged, not capped.
    expect(doc.line.hours['2026-10-12T07:00:00.000Z']).toEqual({
      from: '2026-10-12T07:00:00.000Z',
      to: '2026-10-12T08:00:00.000Z',
      plannedBusyMs: 1_800_000,
      good: { 'VB-100': 13 },
      idealMs: '1950000/1',
      oee: { fraction: '13/12', decimal: '1.0833' },
      aboveOne: true,
      provisional: false,
    });
  });
});

describe('LineOeeTruth on synthetic events (#230)', () => {
  // Monday 06:00 Istanbul.
  const T0 = Date.UTC(2026, 9, 12, 3);
  let config: PlantConfig;
  beforeAll(async () => {
    config = await loadDefaultConfig();
  });

  const state = (machineId: string, at: number, from: string, to: string): PlantEvent =>
    ({ type: 'state', machineId, at, from, to }) as PlantEvent;
  const pack = (at: number, partId: number): PlantEvent => ({
    type: 'cycle-complete',
    at,
    machineId: 'pck-01',
    product: 'VB-100',
    partId,
    serial: `S${String(partId)}`,
    result: 'good',
  });

  it("subtracts the bottleneck's planned maintenance and marks buckets past the cut-off provisional", () => {
    const truth = new LineOeeTruth(config, T0, 'schedule', 'hash');
    const events = [
      state('asm-01', T0, 'Off', 'Idle'),
      pack(T0 + HOUR + 10 * 60_000, 1),
      state('asm-01', T0 + 2 * HOUR, 'Idle', 'Maintenance'),
      state('lkt-01', T0 + 2 * HOUR, 'Off', 'Maintenance'),
      state('asm-01', T0 + 2 * HOUR + 15 * 60_000, 'Maintenance', 'Idle'),
    ];
    for (const event of events) truth.record(event);
    const now = T0 + 3.5 * HOUR;
    const section = truth.build(now);
    // Only the bottleneck's Maintenance is a planned stop (LKT-01's calibration isn't); the
    // shift's break at 10:00 Istanbul lies after the cut-off.
    expect(section.plannedStops).toEqual([
      {
        from: '2026-10-12T05:00:00.000Z',
        to: '2026-10-12T05:15:00.000Z',
        kind: 'maintenance',
        equipment: 'asm-01',
      },
    ]);
    const hours = Object.values(section.line.hours);
    expect(hours.map((h) => [h.plannedBusyMs, h.provisional])).toEqual([
      [HOUR, false],
      [HOUR, false],
      [HOUR - 15 * 60_000, false],
      [HOUR / 2, true],
    ]);
    expect(section.line.hours['2026-10-12T04:00:00.000Z']?.oee).toEqual({
      fraction: '1/24',
      decimal: '0.0417',
    });
    expect(section.line.shifts['2026-10-12/A']).toMatchObject({
      to: '2026-10-12T06:30:00.000Z',
      plannedBusyMs: 3.5 * HOUR - 15 * 60_000,
      provisional: true,
    });
    // Cut inside the maintenance: as a run that ended then, the stop runs to the cut-off.
    const cut = truth.build(now, T0 + 2 * HOUR + 10 * 60_000);
    expect(cut.plannedStops).toEqual([
      {
        from: '2026-10-12T05:00:00.000Z',
        to: '2026-10-12T05:10:00.000Z',
        kind: 'maintenance',
        equipment: 'asm-01',
      },
    ]);
    const ended = new LineOeeTruth(config, T0, 'schedule', 'hash');
    for (const event of events.filter((e) => e.at < T0 + 2 * HOUR + 10 * 60_000)) {
      ended.record(event);
    }
    expect(cut).toEqual(ended.build(T0 + 2 * HOUR + 10 * 60_000));
    // A cut before the start sees nothing.
    expect(truth.build(now, T0 - 1)).toMatchObject({
      plannedStops: [],
      line: { hours: {}, shifts: {} },
      orders: {},
    });
  });

  it('refuses a job fact before its acceptance', () => {
    const truth = new LineOeeTruth(config, T0, 'orders', 'hash');
    truth.record({
      type: 'job',
      at: T0,
      machineId: 'cnc-01',
      transition: 'started',
      commandId: 'C1',
      orderId: 'PO-1',
      product: 'VB-100',
      quantity: 1,
    });
    expect(() => truth.build(T0 + HOUR)).toThrow(/started before it was accepted/);
  });
});
