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
      // The dispatches' notBefore (the run header's), the third term (ADR-0036 amendment).
      const notBefore = new Map(
        (options.dispatches ?? []).map((d) => [d.commandId, d.notBefore] as const),
      );
      const head = new Map<string, number>();
      for (const queue of queues.values()) {
        queue.forEach((job, i) => {
          const previous = queue[i - 1];
          const earliest = notBefore.get(job.id) ?? job.accepted;
          if (previous === undefined) head.set(job.id, Math.max(job.accepted, earliest));
          else if (previous.completed !== undefined) {
            head.set(job.id, Math.max(job.accepted, previous.completed, earliest));
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

  it('orders-01: hand-checked PO-2610-007 and Monday shift C under the notBefore amendment', async () => {
    const doc = JSON.parse(
      await readFile(resolve(GOLDEN, 'orders-01', 'line-oee.json'), 'utf8'),
    ) as LineOeeSection;
    // PO-2610-007, 20 × VB-200 on CNC-01: accepted at the run's start, PO-2610-005 before it
    // completes Monday 16:19:59.737Z, but its notBefore is Tuesday 08:17Z: head time
    // max(03:00Z Mon, 16:19:59.737Z Mon, 08:17Z Tue) = 08:17Z Tue (`notBefore`). Window
    // 08:17:00–10:33:19.033 = 8 179 033 ms: Setup VB-100→VB-200 08:17–08:42 (1 500 000), Running
    // with three micro-stops (5 194 + 11 913 + 43 957 = 61 064 ms). APT 6 679 033; 20 cycles, one
    // scrap: ideal 20 × 330 000 = 6 600 000. OEE = 6 600 000 × 19 / (8 179 033 × 20).
    const order = doc.orders['PO-2610-007'];
    expect(order?.jobOee['PO-2610-007~OP10~1']).toMatchObject({
      headTime: '2026-10-13T08:17:00.000Z',
      headSource: 'notBefore',
      window: { from: '2026-10-13T08:17:00.000Z', to: '2026-10-13T10:33:19.033Z', open: false },
    });
    expect(order?.oee.totals).toMatchObject({
      plannedBusyMs: 8_179_033,
      actualProductionMs: 6_679_033,
      microStopMs: 61_064,
      idealMs: 6_600_000,
      good: 19,
      produced: 20,
    });
    expect(order?.oee.oee).toEqual({ fraction: '6270000/8179033', decimal: '0.7666' });
    // In progress 08:17Z to its last pack 11:05:58.664Z (no break inside): 10 138 664 ms;
    // 19 × 210 000 = 3 990 000 → 0.3935.
    expect(order?.line).toMatchObject({
      from: '2026-10-13T08:17:00.000Z',
      to: '2026-10-13T11:05:58.664Z',
      plannedBusyMs: 10_138_664,
      idealMs: '3990000/1',
      oee: { fraction: '498750/1267333', decimal: '0.3935' },
    });
    // Monday shift C (22:00–06:00 Istanbul): PO-2610-005 completed at 16:25:23Z, and both
    // remaining orders wait for Tuesday's notBefore: no order in progress, planned busy time 0,
    // line OEE null (before the amendment: 27 000 000 ms planned and 0).
    expect(doc.line.shifts['2026-10-12/C']).toMatchObject({
      plannedBusyMs: 0,
      good: {},
      oee: null,
      aboveOne: false,
    });
    // Monday shift B ends its in-progress time at PO-2610-005's completion: 11:00–16:25:23.014Z
    // less the break 15:00–15:30Z = 17 723 014 ms.
    expect(doc.line.shifts['2026-10-12/B']?.plannedBusyMs).toBe(17_723_014);
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

  // One order on both CNCs (#251 review): C1 on CNC-01 from the start, C2 on CNC-02 held by its
  // notBefore until T0 + 30 min. Cycles of 4 min (the VB-100 ideal), packs at PCK-01.
  const M = 60_000;
  const S = (machineId: string, at: number, from: string, to: string, cause?: string) =>
    ({ type: 'state', machineId, at, from, to, ...(cause ? { cause } : {}) }) as PlantEvent;
  const job = (
    machineId: string,
    at: number,
    transition: 'accepted' | 'started' | 'completed',
    commandId: string,
    quantity: number,
  ): PlantEvent => ({
    type: 'job',
    at,
    machineId,
    transition,
    commandId,
    orderId: 'PO-1',
    product: 'VB-100',
    quantity,
  });
  const blank = (machineId: string, at: number, partId: number): PlantEvent => ({
    type: 'material-consumed',
    at,
    machineId,
    partId,
    material: 'BLANK-100',
    lotId: 'L1',
  });
  const op10 = (machineId: string, at: number, partId: number): PlantEvent => ({
    type: 'cycle-complete',
    at,
    machineId,
    product: 'VB-100',
    partId,
    serial: `S${String(partId)}`,
    result: 'good',
  });
  const twoCncs = (): PlantEvent[] => [
    S('cnc-01', T0, 'Off', 'Setup', 'CHANGEOVER'),
    job('cnc-01', T0, 'accepted', 'C1', 2),
    S('cnc-02', T0, 'Off', 'Idle', 'NO-ORDER'),
    job('cnc-02', T0, 'accepted', 'C2', 1),
    job('cnc-01', T0 + 25 * M, 'started', 'C1', 2),
    S('cnc-01', T0 + 25 * M, 'Setup', 'Running'),
    blank('cnc-01', T0 + 25 * M, 1),
    op10('cnc-01', T0 + 29 * M, 1),
    blank('cnc-01', T0 + 29 * M, 2),
    S('cnc-02', T0 + 30 * M, 'Idle', 'Setup', 'CHANGEOVER'),
    S('cnc-01', T0 + 31 * M, 'Running', 'Stopped', 'JAM'),
    S('cnc-01', T0 + 31 * M + 20_000, 'Stopped', 'Running'),
    op10('cnc-01', T0 + 33 * M, 2),
    job('cnc-01', T0 + 33 * M, 'completed', 'C1', 2),
    S('cnc-01', T0 + 33 * M, 'Running', 'Idle', 'NO-ORDER'),
    job('cnc-02', T0 + 55 * M, 'started', 'C2', 1),
    S('cnc-02', T0 + 55 * M, 'Setup', 'Running'),
    blank('cnc-02', T0 + 55 * M, 3),
    op10('cnc-02', T0 + 59 * M, 3),
    job('cnc-02', T0 + 59 * M, 'completed', 'C2', 1),
    S('cnc-02', T0 + 59 * M, 'Running', 'Idle', 'NO-ORDER'),
    // Exactly on the hour boundary 04:00Z: in the 04:00 hour, not the 03:00 one.
    pack(T0 + HOUR, 1),
    pack(T0 + 80 * M, 2),
    pack(T0 + 90 * M, 3),
  ];
  const ordersTruth = (events: readonly PlantEvent[]): LineOeeTruth => {
    const truth = new LineOeeTruth(config, T0, 'orders', 'hash', (id) =>
      id === 'C2' ? T0 + 30 * M : undefined,
    );
    for (const event of events) truth.record(event);
    return truth;
  };

  it('starts an order on both CNCs at its earliest head time and sums its jobs (#251 review)', () => {
    const section = ordersTruth(twoCncs()).build(T0 + 2 * HOUR);
    const order = section.orders['PO-1'];
    expect(order?.jobOee.C1).toMatchObject({
      headTime: '2026-10-12T03:00:00.000Z',
      headSource: 'accepted',
      window: { from: '2026-10-12T03:00:00.000Z', to: '2026-10-12T03:33:00.000Z', open: false },
      cycles: 2,
    });
    expect(order?.jobOee.C2).toMatchObject({
      headTime: '2026-10-12T03:30:00.000Z',
      headSource: 'notBefore',
      window: { from: '2026-10-12T03:30:00.000Z', to: '2026-10-12T03:59:00.000Z', open: false },
      cycles: 1,
    });
    // C1: Setup 25 min, Running 8 min with a 20 s micro-stop; C2: Setup 25 min, Running 4 min.
    expect(order?.jobOee.C1?.oee?.totals.plannedBusyMs).toBe(33 * M);
    expect(order?.jobOee.C2?.oee?.totals.plannedBusyMs).toBe(29 * M);
    expect(order?.oee.totals).toMatchObject({
      plannedBusyMs: 62 * M,
      actualProductionMs: 12 * M,
      microStopMs: 20_000,
      idealMs: 3 * 240_000,
      produced: 3,
      good: 3,
    });
    expect(order?.oee.oee).toEqual({ fraction: '6/31', decimal: '0.1935' });
    expect(order?.completedAt).toBe('2026-10-12T04:30:00.000Z');
    expect(order?.firstPassYield).toMatchObject({ firstPassGood: 3, started: 3 });
    // In progress from the earlier head time (C1's 03:00Z), not C2's.
    expect(section.inProgress).toEqual([
      {
        orderId: 'PO-1',
        from: '2026-10-12T03:00:00.000Z',
        to: '2026-10-12T04:30:00.000Z',
        open: false,
      },
    ]);
    expect(order?.line).toMatchObject({ plannedBusyMs: 90 * M, idealMs: '450000/1' });
    // The pack at 04:00:00.000Z is the 04:00 hour's.
    expect(section.line.hours['2026-10-12T03:00:00.000Z']?.good).toEqual({});
    expect(section.line.hours['2026-10-12T04:00:00.000Z']?.good).toEqual({ 'VB-100': 3 });
    // After the order nothing is in progress: the 04:00 hour is planned only to 04:30.
    expect(section.line.hours['2026-10-12T04:00:00.000Z']?.plannedBusyMs).toBe(30 * M);
  });

  it('cuts exactly on an event time, and keeps a short stop open at the cut provisional (#251 review)', () => {
    const truth = ordersTruth(twoCncs());
    // At C1's completion (03:33Z): the `completed` fact and the second cycle are the next read's.
    const atCompletion = truth.build(T0 + 2 * HOUR, T0 + 33 * M);
    const c1 = atCompletion.orders['PO-1']?.jobOee.C1;
    expect(c1?.window).toEqual({
      from: '2026-10-12T03:00:00.000Z',
      to: '2026-10-12T03:33:00.000Z',
      open: true,
    });
    expect(c1?.cycles).toBe(1);
    // Inside the 20 s jam: the stop is open at the cut and below the threshold so far, so the
    // job's and the order's OEE are provisional.
    const inJam = truth.build(T0 + 2 * HOUR, T0 + 31 * M + 10_000);
    expect(inJam.orders['PO-1']?.jobOee.C1?.oee).toMatchObject({
      provisional: true,
      totals: { microStopMs: 10_000 },
    });
    expect(inJam.orders['PO-1']?.oee.provisional).toBe(true);
    // C2 is not head yet at 03:20Z (its notBefore is 03:30Z): no window, the order pending, and
    // in progress from C1's head time.
    const before = truth.build(T0 + 2 * HOUR, T0 + 20 * M);
    expect(before.orders['PO-1']?.jobOee.C2?.window).toBeNull();
    expect(before.orders['PO-1']?.pending).toBe(true);
    expect(before.inProgress[0]?.from).toBe('2026-10-12T03:00:00.000Z');
  });

  it('clips a break to the run start when the run starts inside it (#251 review)', () => {
    // Monday 10:10 Istanbul, inside shift A's break 10:00–10:30.
    const start = Date.UTC(2026, 9, 12, 7, 10);
    const truth = new LineOeeTruth(config, start, 'schedule', 'hash');
    const section = truth.build(Date.UTC(2026, 9, 12, 8));
    expect(section.plannedStops).toEqual([
      { from: '2026-10-12T07:10:00.000Z', to: '2026-10-12T07:30:00.000Z', kind: 'break' },
    ]);
    expect(section.line.hours['2026-10-12T07:00:00.000Z']).toMatchObject({
      from: '2026-10-12T07:10:00.000Z',
      plannedBusyMs: 30 * M,
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
