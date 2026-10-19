/**
 * Line OEE (#232) over fake module interfaces: the truth's conventions (good packed × the
 * bottleneck's effective cycle ÷ planned busy time, breaks and the bottleneck's Maintenance as
 * planned stops, in orders mode only in-progress time, the exclusive cut-off, `aboveOne`, null
 * without planned time), what makes a bucket final, the cache and the change filter. The golden
 * reconciliation (`order-oee.e2e.test.ts`) runs it over the real modules.
 */
import { resolve } from 'node:path';
import { formatFraction } from '@shopfloor/oee-core';
import { idealCycleMs, loadPlantConfig, type PlantConfig } from '@shopfloor/plant-config';
import { beforeAll, describe, expect, it } from 'vitest';
import type { StoredInterval } from '../equipment/index.ts';
import type { IngestNotice } from '../ingest/index.ts';
import {
  calendar,
  gapTouches,
  lineModel,
  lineValue,
  maintenance,
  type LineModel,
} from './line-inputs.ts';
import { LineOee, ordersFinal, type LineChange, type LineOeeOptions } from './line-oee.ts';
import type { LineOrders, OrderLineView, OrderOeeView } from './order-oee.ts';

const PLANT_CONFIG = resolve(import.meta.dirname, '../../../../../config/plant');
const MIN = 60_000;
const HOUR = 60 * MIN;
/** Monday 06:00 Istanbul: shift A starts (break 07:00–07:30Z, shift end 11:00Z). */
const T0 = Date.parse('2026-10-12T03:00:00.000Z');
const at = (minutes: number): number => T0 + minutes * MIN;

let plant: PlantConfig;
let model: LineModel;
beforeAll(async () => {
  const loaded = await loadPlantConfig(PLANT_CONFIG);
  if (!loaded.ok) throw new Error('plant config');
  plant = loaded.config;
  model = lineModel(equipmentList(), plant.products.operations, idealCycleMs(plant));
});

function equipmentList(): { id: string; operation: string }[] {
  return plant.plant.areas.flatMap((a) =>
    a.workCenters.flatMap((wc) => wc.equipment.map((e) => ({ id: e.id, operation: e.operation }))),
  );
}

interface World {
  /** Final-through per machine, minutes (default `through`). */
  through: number;
  finalThrough: Record<string, number | null>;
  /** Cycles at PCK-01, minutes (good unless said, device epoch 1 unless said). */
  packs: { at: number; product?: string; result?: string; epoch?: number }[];
  /** ASM-01's pieces, minutes (epoch 1 unless said). */
  bottleneck: {
    from: number;
    to: number;
    state: string;
    provisional?: boolean;
    epoch?: number;
  }[];
  gaps: { machine: string; after: number; before: number; epoch?: number }[];
  /** A machine's current device epoch, when not 1. */
  epochs: Record<string, number>;
  revision: number;
  lineOrders: LineOrders;
  processed: number;
  /** Execution's progress of one machine, when it differs from `processed`. */
  processedOf: Record<string, number>;
  watermark: number | null;
}

function world(): World {
  return {
    through: 24 * 60,
    finalThrough: {},
    packs: [],
    bottleneck: [{ from: 0, to: 24 * 60, state: 'Running' }],
    gaps: [],
    epochs: {},
    revision: 0,
    lineOrders: { orders: [], unknownJob: new Set(), cncThrough: new Map() },
    processed: 24 * 60,
    processedOf: {},
    watermark: 24 * 60,
  };
}

function sources(w: World, mode: 'schedule' | 'orders' = 'schedule') {
  const calls = { cycles: 0 };
  const listeners = {
    pieces: new Set<(change: { equipment: string; from: Date; to: Date }) => void>(),
    stored: new Set<(notice: IngestNotice) => void>(),
    orders: new Set<(change: object) => void>(),
  };
  const time = (machine: string): Date | null => {
    const value = machine in w.finalThrough ? w.finalThrough[machine] : w.through;
    return value === null || value === undefined ? null : new Date(at(value));
  };
  const views = new Map<string, OrderOeeView>();
  const options = {
    shiftPattern: plant.shifts,
    productionMode: mode,
    orderOee: {
      lineModel: () => Promise.resolve(model),
      lineOrders: () => Promise.resolve(w.lineOrders),
      order: (id: string) => Promise.resolve(views.get(id)),
      onChange: (l: (change: object) => void) => {
        listeners.orders.add(l);
        return () => listeners.orders.delete(l);
      },
    },
    ingest: {
      deviceProgresses: (machines: readonly string[]) =>
        Promise.resolve(
          new Map(
            machines.map((equipment) => [
              equipment,
              {
                equipment,
                epoch: w.epochs[equipment] ?? 1,
                settledTime: time(equipment),
                settledSeq: 1,
              },
            ]),
          ),
        ),
      gapIncidents: (streams: readonly { equipment: string; epoch: number }[]) =>
        Promise.resolve(
          streams.flatMap(({ equipment, epoch }) =>
            w.gaps
              .filter((g) => g.machine === equipment && (g.epoch ?? 1) === epoch)
              .map((g, i) => ({
                equipment,
                epoch,
                id: i + 1,
                seqFrom: 5,
                seqTo: 6,
                after: new Date(at(g.after)),
                before: new Date(at(g.before)),
              })),
          ),
        ),
      cycleResults: (machine: string, from: Date, to: Date) => {
        calls.cycles++;
        return Promise.resolve(
          machine !== 'pck-01'
            ? []
            : w.packs
                .filter((p) => at(p.at) >= from.getTime() && at(p.at) < to.getTime())
                .map((p) => ({
                  epoch: p.epoch ?? 1,
                  at: new Date(at(p.at)),
                  product: p.product ?? 'VB-100',
                  result: p.result ?? 'good',
                })),
        );
      },
      onStored: (l: (notice: IngestNotice) => void) => {
        listeners.stored.add(l);
        return () => listeners.stored.delete(l);
      },
    },
    equipment: {
      intervals: (machine: string, from: Date, to: Date): Promise<StoredInterval[]> =>
        Promise.resolve(
          (machine === 'asm-01' ? w.bottleneck : [])
            .filter((p) => at(p.to) > from.getTime() && at(p.from) < to.getTime())
            .map((p) => ({
              equipment: machine,
              epoch: p.epoch ?? 1,
              start: new Date(at(p.from)),
              end: new Date(at(p.to)),
              state: p.state,
              cause: null,
              hour: new Date(at(p.from)),
              shiftKey: '2026-10-12/A',
              provisional: p.provisional === true,
              intervalStart: new Date(at(p.from)),
              startSeq: null,
            })),
        ),
      revision: () => Promise.resolve(w.revision),
      onPiecesChanged: (l: (change: { equipment: string; from: Date; to: Date }) => void) => {
        listeners.pieces.add(l);
        return () => listeners.pieces.delete(l);
      },
      watermarks: () =>
        w.watermark === null ? [] : [{ epoch: 1, watermark: new Date(at(w.watermark)) }],
    },
    execution: {
      processedThrough: () =>
        new Map(
          model.machines.map((m) => [
            m,
            {
              equipment: m,
              epoch: 1,
              settledTime: new Date(at(w.processedOf[m] ?? w.processed)),
              settledSeq: 1,
            },
          ]),
        ),
    },
  } as unknown as LineOeeOptions;
  return { options, calls, listeners, views };
}

const hours = (oee: LineOee, from: number, to: number) =>
  oee.buckets({ bucket: 'hour', from: new Date(at(from)), to: new Date(at(to)) });

const fraction = (value: { result: { oee: Parameters<typeof formatFraction>[0] | null } }) =>
  value.result.oee === null ? null : formatFraction(value.result.oee);

describe('line OEE inputs (#232)', () => {
  it('derives ASM-01 as the bottleneck of both products and the line’s machines', () => {
    expect(model.bottleneckMachines).toEqual(['asm-01']);
    expect(model.packing).toEqual(['pck-01']);
    expect(model.first).toEqual(['cnc-01', 'cnc-02']);
    expect(
      Object.fromEntries(
        Object.entries(model.effectiveCycleMs).map(([p, f]) => [p, formatFraction(f)]),
      ),
    ).toEqual({
      'VB-100': '150000/1',
      'VB-200': '210000/1',
    });
  });

  it('cuts the calendar to its span: scheduled shifts and breaks', () => {
    const { scheduled, breaks } = calendar(plant.shifts, { from: at(-60), to: at(5 * 60) });
    expect(scheduled).toEqual([{ from: T0, to: at(5 * 60) }]);
    expect(breaks).toEqual([{ from: at(4 * 60), to: at(4 * 60 + 30) }]);
    // A span starting inside a break clips it.
    expect(calendar(plant.shifts, { from: at(4 * 60 + 10), to: at(5 * 60) }).breaks).toEqual([
      { from: at(4 * 60 + 10), to: at(4 * 60 + 30) },
    ]);
  });

  it('takes only Maintenance pieces as planned stops', () => {
    const piece = (from: number, to: number, state: string) => ({
      start: new Date(at(from)),
      end: new Date(at(to)),
      state,
    });
    expect(
      maintenance([
        piece(0, 10, 'Running'),
        piece(10, 20, 'Maintenance'),
        piece(20, 25, 'Maintenance'),
      ]),
    ).toEqual([{ from: at(10), to: at(25) }]);
  });

  it('counts planned time and packs before the cut-off only, not capped, null without planned time', () => {
    const base = {
      bucket: { from: T0, to: at(60) },
      scheduled: [{ from: T0, to: at(8 * 60) }],
      plannedStops: [],
      effectiveCycleMs: model.effectiveCycleMs,
    };
    const packs = [at(10), at(29), at(30), at(59)].map((t) => ({ at: t, product: 'VB-100' }));
    const cut = lineValue({ ...base, cut: at(30), packs });
    expect([cut.through, cut.plannedBusyMs, cut.good]).toEqual([at(30), 30 * MIN, { 'VB-100': 2 }]);
    expect(fraction(cut)).toBe('1/6');
    const many = Array.from({ length: 30 }, (_, i) => ({ at: at(i), product: 'VB-100' }));
    const above = lineValue({ ...base, cut: at(60), packs: many });
    expect([fraction(above), above.result.aboveOne]).toEqual(['5/4', true]);
    const exact = lineValue({ ...base, cut: at(60), packs: many.slice(0, 24) });
    expect([fraction(exact), exact.result.aboveOne]).toEqual(['1/1', false]);
    const none = lineValue({ ...base, scheduled: [], cut: at(60), packs });
    expect([none.plannedBusyMs, none.result.oee]).toEqual([0, null]);
    // In orders mode only in-progress time is planned.
    const orders = lineValue({
      ...base,
      cut: at(60),
      packs,
      inProgress: [{ from: at(15), to: at(45) }],
    });
    expect(orders.plannedBusyMs).toBe(30 * MIN);
    // Before the bucket's start the cut-off counts nothing.
    expect(lineValue({ ...base, cut: at(-10), packs }).through).toBe(T0);
  });

  it('touches gaps at the range’s edges, open ends unbounded', () => {
    const gap = (after: number | null, before: number | null) => ({
      after: after === null ? null : new Date(after),
      before: before === null ? null : new Date(before),
    });
    expect(gapTouches(gap(10, 20), 20, 30)).toBe(true);
    expect(gapTouches(gap(30, 40), 20, 30)).toBe(true);
    expect(gapTouches(gap(31, 40), 20, 30)).toBe(false);
    expect(gapTouches(gap(5, 19), 20, 30)).toBe(false);
    expect(gapTouches(gap(null, null), 20, 30)).toBe(true);
  });
});

describe('line OEE buckets (#232)', () => {
  it('computes hours and shifts in schedule mode: breaks and the bottleneck’s Maintenance are planned stops', async () => {
    const w = world();
    // 20 packs in the first hour: 3 000 000 / 3 600 000 = 5/6 (week-01's first hour).
    w.packs = Array.from({ length: 20 }, (_, i) => ({ at: i * 3 }));
    w.packs.push({ at: 4 * 60 + 40, product: 'VB-200' });
    w.bottleneck = [
      { from: 0, to: 60, state: 'Running' },
      { from: 60, to: 90, state: 'Maintenance' },
      { from: 90, to: 24 * 60, state: 'Running' },
    ];
    const oee = new LineOee(sources(w).options);
    const [first, second, , , fifth] = await hours(oee, 0, 5 * 60);
    expect([
      first?.key,
      first?.value.plannedBusyMs,
      first && fraction(first.value),
      first?.final,
    ]).toEqual(['2026-10-12T03:00:00.000Z', 3_600_000, '5/6', true]);
    expect(second?.value.plannedBusyMs).toBe(1_800_000);
    // 07:00Z: the break, and one VB-200 pack: 210 000 / 1 800 000.
    expect([fifth?.value.plannedBusyMs, fifth?.value.good, fifth && fraction(fifth.value)]).toEqual(
      [1_800_000, { 'VB-200': 1 }, '7/60'],
    );
    const [shift] = await oee.buckets({
      bucket: 'shift',
      from: new Date(at(0)),
      to: new Date(at(60)),
    });
    expect([shift?.key, shift?.value.from, shift?.value.to, shift?.value.plannedBusyMs]).toEqual([
      '2026-10-12/A',
      T0,
      at(8 * 60),
      27_000_000 - 1_800_000,
    ]);
    // Saturday: no shift, nothing planned.
    const [weekend] = await oee.buckets({
      bucket: 'hour',
      from: new Date('2026-10-17T12:00:00.000Z'),
      to: new Date('2026-10-17T13:00:00.000Z'),
    });
    expect([weekend?.value.plannedBusyMs, weekend?.value.result.oee]).toEqual([0, null]);
    // Shift buckets leave out no-shift stretches.
    expect(
      (
        await oee.buckets({
          bucket: 'shift',
          from: new Date('2026-10-17T12:00:00.000Z'),
          to: new Date('2026-10-17T13:00:00.000Z'),
        })
      ).length,
    ).toBe(0);
  });

  it('is final only when the packing and bottleneck machines are final through the bucket’s end', async () => {
    const cases: [string, (w: World) => void][] = [
      ['PCK-01 behind', (w) => (w.finalThrough['pck-01'] = 59)],
      ['ASM-01 behind', (w) => (w.finalThrough['asm-01'] = 30)],
      ['PCK-01 without a settled fact', (w) => (w.finalThrough['pck-01'] = null)],
      [
        'a provisional bottleneck piece',
        (w) => (w.bottleneck = [{ from: 0, to: 600, state: 'Running', provisional: true }]),
      ],
      [
        'a hole in the bottleneck pieces',
        (w) => (w.bottleneck = [{ from: 0, to: 50, state: 'Running' }]),
      ],
    ];
    for (const [label, change] of cases) {
      const w = world();
      change(w);
      const [bucket] = await hours(new LineOee(sources(w).options), 0, 60);
      expect([label, bucket?.final]).toEqual([label, false]);
    }
    // Exactly through the end is final; a CNC behind doesn't matter in schedule mode.
    const w = world();
    w.finalThrough = { 'pck-01': 60, 'asm-01': 60, 'cnc-01': 0 };
    expect((await hours(new LineOee(sources(w).options), 0, 60))[0]?.final).toBe(true);
  });

  it('counts a provisional bucket up to the plant clock', async () => {
    const w = world();
    w.through = 80;
    w.watermark = 90;
    w.packs = [{ at: 70 }, { at: 89 }, { at: 95 }];
    const [, second] = await hours(new LineOee(sources(w).options), 0, 120);
    expect([
      second?.final,
      second?.value.through,
      second?.value.plannedBusyMs,
      second?.value.good,
    ]).toEqual([false, at(90), 30 * MIN, { 'VB-100': 2 }]);
  });

  it('keeps final buckets in memory and reads only the others again', async () => {
    const w = world();
    w.through = 90;
    const { options, calls } = sources(w);
    const oee = new LineOee(options);
    await hours(oee, 0, 120);
    expect(calls.cycles).toBe(1);
    w.through = 24 * 60;
    w.packs = [{ at: 10 }]; // too late for the first hour, kept final
    const [first, second] = await hours(oee, 0, 120);
    expect(calls.cycles).toBe(2);
    expect([first?.value.good, second?.final]).toEqual([{}, true]);
    await hours(oee, 0, 120);
    expect(calls.cycles).toBe(2);
  });

  it('lists written-off gaps on the contributing machines, marks the bucket revisable and never keeps it', async () => {
    const w = world();
    w.revision = 2;
    w.gaps = [
      { machine: 'pck-01', after: 30, before: 31 },
      { machine: 'cnc-01', after: 30, before: 31 }, // not read in schedule mode
    ];
    const { options, calls } = sources(w);
    const oee = new LineOee(options);
    const [first, second] = await hours(oee, 0, 120);
    expect([first?.final, first?.mayRevise, first?.revision, first?.incidents]).toEqual([
      true,
      true,
      2,
      [{ machine: 'pck-01', epoch: 1, id: 1, seqFrom: 5, seqTo: 6 }],
    ]);
    expect([second?.mayRevise, second?.revision, second?.incidents]).toEqual([false, 0, []]);
    await hours(oee, 0, 60);
    expect(calls.cycles).toBe(2);
  });

  it('plans only in-progress time in orders mode, an open order to the plant clock', async () => {
    const w = world();
    w.through = 150;
    w.watermark = 150;
    w.lineOrders = {
      orders: [
        { orderId: 'A', from: at(15), completedAt: at(45), unknown: [] },
        { orderId: 'B', from: at(30), completedAt: at(50), unknown: [] }, // overlaps A: once
        { orderId: 'C', from: at(100), completedAt: null, unknown: [] },
        { orderId: 'D', from: null, completedAt: null, unknown: [] },
      ],
      unknownJob: new Set(),
      cncThrough: new Map(),
    };
    const [first, second, third] = await hours(new LineOee(sources(w, 'orders').options), 0, 180);
    expect(first?.value.plannedBusyMs).toBe(35 * MIN);
    expect([first?.final, second?.value.plannedBusyMs, second?.final]).toEqual([
      true,
      20 * MIN,
      true,
    ]);
    expect([third?.value.plannedBusyMs, third?.final]).toEqual([30 * MIN, false]);
  });

  it('keeps an orders-mode bucket provisional while an input can still change', () => {
    const bucket = { from: at(0), to: at(60) };
    const processed = () => true;
    const orders = (
      unknown: LineOrders['orders'][number]['unknown'],
      completedAt: number | null = null,
      extra: LineOrders['orders'] = [],
    ): LineOrders => ({
      orders: [{ orderId: 'A', from: at(-30), completedAt, unknown }, ...extra],
      unknownJob: new Set(),
      cncThrough: new Map(),
    });
    const job = (
      reason: 'accepted-unknown' | 'accepted-lost' | 'waiting',
      notBefore: number,
      after: string | null = null,
    ) => ({
      orderId: 'A',
      commandId: 'A~OP10~2',
      machine: 'cnc-01',
      notBefore: at(notBefore),
      reason,
      after,
    });
    expect(ordersFinal(bucket, orders([]), model, processed)).toBe(true);
    // Execution behind one machine.
    expect(ordersFinal(bucket, orders([]), model, (m) => m !== 'lkt-01')).toBe(false);
    // An unknown-job incident on a CNC.
    expect(
      ordersFinal(bucket, { ...orders([]), unknownJob: new Set(['cnc-02']) }, model, processed),
    ).toBe(false);
    // An unknown head time from its notBefore on: before it, the bucket stays final.
    expect(ordersFinal(bucket, orders([job('accepted-unknown', 30)]), model, processed)).toBe(
      false,
    );
    expect(ordersFinal(bucket, orders([job('accepted-unknown', 60)]), model, processed)).toBe(true);
    expect(ordersFinal(bucket, orders([job('accepted-lost', 59)]), model, processed)).toBe(false);
    // An order complete before the bucket can't reach into it.
    expect(ordersFinal(bucket, orders([job('accepted-lost', -60)], at(0)), model, processed)).toBe(
      true,
    );
    expect(ordersFinal(bucket, orders([job('accepted-lost', -60)], at(1)), model, processed)).toBe(
      false,
    );
    // A waiting job: covered while its predecessor's order is open, a hole once it is complete.
    const before = (completedAt: number | null) => [
      { orderId: 'P', from: at(-60), completedAt, unknown: [] },
    ];
    expect(
      ordersFinal(bucket, orders([job('waiting', -60, 'P')], null, before(null)), model, processed),
    ).toBe(true);
    expect(
      ordersFinal(
        bucket,
        orders([job('waiting', -60, 'P')], null, before(at(20))),
        model,
        processed,
      ),
    ).toBe(false);
    expect(
      ordersFinal(
        bucket,
        orders([job('waiting', -60, 'P')], null, before(at(60))),
        model,
        processed,
      ),
    ).toBe(true);
    expect(
      ordersFinal(
        bucket,
        orders([job('waiting', 70, 'P')], null, before(at(20))),
        model,
        processed,
      ),
    ).toBe(true);
    expect(ordersFinal(bucket, orders([job('waiting', -60, null)]), model, processed)).toBe(true);
  });

  it('reads the orders-mode finality inputs: execution’s progress and the line machines', async () => {
    const w = world();
    w.processed = 30;
    const [behind] = await hours(new LineOee(sources(w, 'orders').options), 0, 60);
    expect(behind?.final).toBe(false);
    const v = world();
    v.finalThrough = { 'lkt-01': 30 }; // every machine contributes in orders mode
    const [late] = await hours(new LineOee(sources(v, 'orders').options), 0, 60);
    expect([late?.final, late?.value.through]).toEqual([false, at(60)]);
  });

  it('lets a quiet CNC (no job that can still bring a fact) not hold the line back', async () => {
    // CNC-02's last fact at 03:10Z, then Idle with no job until a notBefore ahead: its facts are
    // known for line OEE far past its final-through.
    const w = world();
    w.finalThrough = { 'cnc-02': 10 };
    w.processedOf = { 'cnc-02': 10 };
    w.lineOrders = {
      orders: [],
      unknownJob: new Set(),
      cncThrough: new Map([
        ['cnc-01', at(24 * 60)],
        ['cnc-02', Number.POSITIVE_INFINITY],
      ]),
    };
    const read = async () => (await hours(new LineOee(sources(w, 'orders').options), 0, 60))[0];
    expect((await read())?.final).toBe(true);
    // Execution not through the quiet CNC's own facts yet.
    w.processedOf = { 'cnc-02': 5 };
    expect((await read())?.final).toBe(false);
    // A job of it that may still bring a fact before the bucket's end.
    w.processedOf = { 'cnc-02': 10 };
    w.lineOrders = { ...w.lineOrders, cncThrough: new Map([['cnc-02', at(10)]]) };
    expect((await read())?.final).toBe(false);
  });

  it('serves the current hour and shift at the plant clock', async () => {
    const w = world();
    w.watermark = null;
    const oee = new LineOee(sources(w).options);
    expect(await oee.current()).toEqual({ hour: null, shift: null });
    w.watermark = 60; // 04:00:00.000Z: the hour in progress is 03:00
    const { hour, shift } = await oee.current();
    expect([hour?.key, shift?.key]).toEqual(['2026-10-12T03:00:00.000Z', '2026-10-12/A']);
    w.watermark = (5 * 24 - 3) * 60 + 9 * 60; // Saturday 09:00Z: no shift
    expect((await oee.current()).shift).toBeNull();
  });

  it('serves the orders in progress over a range with their own line OEE (orders mode only)', async () => {
    const w = world();
    w.lineOrders = {
      orders: [
        { orderId: 'A', from: at(0), completedAt: at(30), unknown: [] },
        { orderId: 'B', from: at(40), completedAt: null, unknown: [] },
        { orderId: 'C', from: null, completedAt: null, unknown: [] },
        { orderId: 'E', from: at(200), completedAt: null, unknown: [] },
      ],
      unknownJob: new Set(),
      cncThrough: new Map(),
    };
    const { options, views } = sources(w, 'orders');
    const line = (from: number): OrderLineView => ({
      value: lineValue({
        bucket: { from: at(from), to: at(from + 30) },
        cut: at(from + 30),
        scheduled: [],
        plannedStops: [],
        packs: [],
        effectiveCycleMs: model.effectiveCycleMs,
      }),
      open: false,
      final: true,
    });
    for (const [id, from] of [
      ['A', 0],
      ['B', 40],
    ] as const) {
      views.set(id, {
        orderId: id,
        product: 'VB-100',
        status: 'completed',
        line: line(from),
        incidents: [],
        mayRevise: false,
        revision: 0,
      } as unknown as OrderOeeView);
    }
    const oee = new LineOee(options);
    const found = await oee.orders({ from: new Date(at(35)), to: new Date(at(120)) });
    expect(found.map((o) => o.orderId)).toEqual(['B']);
    expect(
      (await oee.orders({ from: new Date(at(0)), to: new Date(at(120)) })).map((o) => o.orderId),
    ).toEqual(['A', 'B']);
    expect(
      await new LineOee(sources(w).options).orders({
        from: new Date(at(0)),
        to: new Date(at(120)),
      }),
    ).toEqual([]);
  });

  it('tells only the changes it reads: contributing machines, the packing cycles, the orders in orders mode', async () => {
    for (const mode of ['schedule', 'orders'] as const) {
      const { options, listeners } = sources(world(), mode);
      const oee = new LineOee(options);
      const seen: LineChange[] = [];
      oee.onChange((change) => seen.push(change));
      oee.onChange(() => {
        throw new Error('a listener’s failure stays with it');
      });
      await oee.start();
      const hour = { from: new Date(T0), to: new Date(T0 + HOUR) };
      for (const l of listeners.pieces) {
        l({ equipment: 'cnc-01', ...hour });
        l({ equipment: 'asm-01', ...hour });
      }
      for (const l of listeners.stored) {
        l({
          type: 'cycle',
          cycle: { equipment: 'pck-01', sourceTime: new Date(T0 + 5 * MIN) },
        } as IngestNotice);
        l({
          type: 'cycle',
          cycle: { equipment: 'cnc-01', sourceTime: new Date(T0) },
        } as IngestNotice);
        l({ type: 'sample' } as IngestNotice);
      }
      for (const l of listeners.orders) l({ orderId: 'A' });
      expect(seen).toEqual([
        ...(mode === 'orders' ? [{ equipment: 'cnc-01', ...hour }] : []),
        { equipment: 'asm-01', ...hour },
        { equipment: 'pck-01', ...hour },
        ...(mode === 'orders' ? [{ orders: true }] : []),
      ]);
      expect(oee.productionMode).toBe(mode);
      oee.stop();
      expect(listeners.pieces.size + listeners.stored.size + listeners.orders.size).toBe(0);
    }
  });

  it('is never final with its value counted short: the final-through never passes the plant clock', async () => {
    // Every machine final far past the hour (an old epoch's progress, say), the clock at 03:20Z:
    // 1 pack of 3 counted, so the hour is not final, and not kept.
    const w = world();
    w.packs = [{ at: 10 }, { at: 30 }, { at: 50 }];
    w.watermark = 20;
    const oee = new LineOee(sources(w).options);
    const [early] = await hours(oee, 0, 60);
    expect([early?.final, early?.value.good, early?.value.through]).toEqual([
      false,
      { 'VB-100': 1 },
      at(20),
    ]);
    w.watermark = 24 * 60;
    const [later] = await hours(oee, 0, 60);
    expect([later?.final, later?.value.good]).toEqual([true, { 'VB-100': 3 }]);
    // No clock at all: nothing counted, nothing final.
    const v = world();
    v.packs = [{ at: 10 }];
    v.watermark = null;
    const [none] = await hours(new LineOee(sources(v).options), 0, 60);
    expect([none?.final, none?.value.plannedBusyMs, none?.value.good]).toEqual([false, 0, {}]);
  });

  it('counts only good packs: a scrap or rework cycle at PCK-01 is no good unit', async () => {
    const w = world();
    w.packs = [{ at: 10 }, { at: 20, result: 'scrap' }, { at: 30, result: 'rework' }];
    const [first] = await hours(new LineOee(sources(w).options), 0, 60);
    expect(first?.value.good).toEqual({ 'VB-100': 1 });
  });

  it('counts only the newest device epoch with data in a bucket, never final across epochs or for an ended run', async () => {
    // A simulator restarted over the same plant time: PCK-01's epoch 2 and the old run's epoch 1
    // both pack in 03:00Z; ASM-01's Maintenance of the old run isn't a planned stop of the new one.
    const w = world();
    w.epochs = { 'pck-01': 2, 'asm-01': 2 };
    w.packs = [
      { at: 10, epoch: 1 },
      { at: 20, epoch: 1 },
      { at: 30, epoch: 2 },
    ];
    w.bottleneck = [
      { from: 0, to: 30, state: 'Maintenance', epoch: 1 },
      { from: 0, to: 24 * 60, state: 'Running', epoch: 2 },
    ];
    const oee = new LineOee(sources(w).options);
    const [mixed] = await hours(oee, 0, 60);
    expect([mixed?.final, mixed?.value.good, mixed?.value.plannedBusyMs]).toEqual([
      false,
      { 'VB-100': 1 },
      3_600_000,
    ]);
    // Only the old run's data in a bucket (the current epoch is 2): counted, not final.
    const v = world();
    v.epochs = { 'pck-01': 2 };
    v.packs = [{ at: 10, epoch: 1 }];
    const [old] = await hours(new LineOee(sources(v).options), 0, 60);
    expect([old?.final, old?.value.good]).toEqual([false, { 'VB-100': 1 }]);
    // The current epoch alone: final.
    const u = world();
    u.epochs = { 'pck-01': 2, 'asm-01': 2 };
    u.packs = [{ at: 10, epoch: 2 }];
    u.bottleneck = [{ from: 0, to: 24 * 60, state: 'Running', epoch: 2 }];
    const [current] = await hours(new LineOee(sources(u).options), 0, 60);
    expect([current?.final, current?.value.good]).toEqual([true, { 'VB-100': 1 }]);
  });

  it('looks gaps up in each contributing machine’s current epoch', async () => {
    const w = world();
    w.epochs = { 'pck-01': 3 };
    w.gaps = [
      { machine: 'pck-01', after: 30, before: 31, epoch: 3 },
      { machine: 'pck-01', after: 30, before: 31, epoch: 1 }, // an ended run's
    ];
    const [first] = await hours(new LineOee(sources(w).options), 0, 60);
    expect(first?.incidents).toEqual([
      { machine: 'pck-01', epoch: 3, id: 1, seqFrom: 5, seqTo: 6 },
    ]);
  });

  it('warns once when a job fact or a dispatch command shows up in schedule mode', async () => {
    for (const mode of ['schedule', 'orders'] as const) {
      for (const first of ['job', 'command'] as const) {
        const { options, listeners } = sources(world(), mode);
        const warnings: string[] = [];
        const oee = new LineOee({
          ...options,
          log: { warn: (_o, message) => warnings.push(message) },
        });
        await oee.start();
        const job = () => {
          for (const l of listeners.stored) {
            l({ type: 'job', fact: { equipment: 'cnc-01' } } as unknown as IngestNotice);
          }
        };
        const command = () => {
          for (const l of listeners.orders) l({ machine: 'cnc-01' });
        };
        // An order or execution change alone (no command) says nothing about the mode.
        for (const l of listeners.orders) l({ orderId: 'A' });
        expect(oee.mismatch).toBe(false);
        if (first === 'job') job();
        else command();
        job();
        command();
        expect([mode, first, warnings.length, oee.mismatch]).toEqual(
          mode === 'schedule' ? [mode, first, 1, true] : [mode, first, 0, false],
        );
        if (mode === 'schedule') expect(warnings[0]).toMatch(/MES_PRODUCTION_MODE=schedule/);
        oee.stop();
      }
    }
  });
});
