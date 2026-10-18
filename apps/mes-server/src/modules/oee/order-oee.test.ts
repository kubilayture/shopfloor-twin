/**
 * `OrderOee` over fake module interfaces (#231): what makes an order's OEE final, and what keeps
 * it provisional or never final (a lost fact), without a database. The golden reconciliation
 * (`order-oee.e2e.test.ts`) and `order-oee.test.ts` run it over the real modules.
 */
import { resolve } from 'node:path';
import { idealCycleMs, loadPlantConfig, type PlantConfig } from '@shopfloor/plant-config';
import { beforeAll, describe, expect, it } from 'vitest';
import type { StoredInterval } from '../equipment/index.ts';
import type { UnitRecord } from '../execution/index.ts';
import type { CommandRecord, OrderChange, OrderRecord } from '../orders/index.ts';
import { OrderOee, type OrderOeeOptions } from './order-oee.ts';

const PLANT_CONFIG = resolve(import.meta.dirname, '../../../../../config/plant');
const MIN = 60_000;
/** Monday 06:00 Istanbul: shift A starts. */
const T0 = Date.parse('2026-10-12T03:00:00.000Z');
const at = (minutes: number): Date => new Date(T0 + minutes * MIN);

let plant: PlantConfig;
beforeAll(async () => {
  const loaded = await loadPlantConfig(PLANT_CONFIG);
  if (!loaded.ok) throw new Error('plant config');
  plant = loaded.config;
});

interface World {
  order: Partial<OrderRecord>;
  commands: Partial<CommandRecord>[];
  pieces: { from: number; to: number; state: string; provisional?: boolean }[];
  units: { commandId: string; op10: number; records?: [string, 'good' | 'scrap' | 'rework'][] }[];
  completedAt: Date | null;
  inMachine: number;
  finalThrough: Date | null;
  processed: Date | null;
}

/** One order A, one job of 2 blanks on CNC-01: Setup 10 min, Running 20 min, then Idle. */
function world(): World {
  return {
    order: {
      id: 'A',
      product: 'VB-100',
      quantity: 2,
      dispatched: 2,
      inFlight: 0,
      status: 'completed',
    },
    commands: [
      {
        commandId: 'A~OP10~1',
        orderId: 'A',
        startedAt: at(10),
        completedAt: at(30),
      },
    ],
    pieces: [
      { from: 0, to: 10, state: 'Setup' },
      { from: 10, to: 30, state: 'Running' },
      { from: 30, to: 60, state: 'Idle' },
    ],
    units: [
      { commandId: 'A~OP10~1', op10: 20 },
      { commandId: 'A~OP10~1', op10: 30 },
    ],
    completedAt: at(50),
    inMachine: 0,
    finalThrough: at(60),
    processed: at(60),
  };
}

let position = 0;
const commandRecord = (c: Partial<CommandRecord>): CommandRecord =>
  ({
    commandId: 'X',
    orderId: 'X',
    n: 1,
    equipment: 'cnc-01',
    product: 'VB-100',
    quantity: 2,
    notBefore: at(0),
    deviceEpoch: 1,
    queuePosition: ++position,
    settled: true,
    acceptedBy: 'fact',
    acceptedSeq: position,
    acceptedAt: at(0),
    job: 'started',
    startedAt: null,
    completedAt: null,
    ...c,
  }) as CommandRecord;

function sources(w: World, calls = { order: 0 }) {
  const listeners = {
    orders: new Set<(change: OrderChange) => void>(),
    execution: new Set<(change: { type: 'order'; orderId: string }) => void>(),
    pieces: new Set<() => void>(),
  };
  const commands = w.commands.map(commandRecord);
  const units: UnitRecord[] = w.units.map(
    (u, i) =>
      ({
        epoch: 1,
        partId: i + 1,
        product: 'VB-100',
        orderId: commands.find((c) => c.commandId === u.commandId)?.orderId ?? null,
        commandId: u.commandId,
        records: [
          {
            operation: 'OP10',
            equipment: 'cnc-01',
            pass: 1,
            at: at(u.op10),
            result: 'good',
            reason: null,
            seq: 1,
          },
          ...(u.records ?? [['OP50', 'good']]).map(([operation, result]) => ({
            operation,
            equipment: 'x',
            pass: 1,
            at: at(u.op10 + 5),
            result,
            reason: null,
            seq: 2,
          })),
        ],
      }) as unknown as UnitRecord,
  );
  const options = {
    orders: {
      order: (id: string) => {
        calls.order++;
        return Promise.resolve(id === w.order.id ? (w.order as OrderRecord) : undefined);
      },
      commands: () => Promise.resolve(commands),
      onChange: (l: (change: OrderChange) => void) => {
        listeners.orders.add(l);
        return () => listeners.orders.delete(l);
      },
    },
    execution: {
      units: ({ orderId }: { orderId?: string }) =>
        Promise.resolve({ units: units.filter((u) => u.orderId === orderId), truncated: false }),
      orderExecution: () =>
        Promise.resolve({ completedAt: w.completedAt, inMachine: { 'cnc-01': w.inMachine } }),
      processedThrough: () =>
        new Map([
          ['cnc-01', { equipment: 'cnc-01', epoch: 1, settledTime: w.processed, settledSeq: 1 }],
        ]),
      onChange: (l: (change: { type: 'order'; orderId: string }) => void) => {
        listeners.execution.add(l);
        return () => listeners.execution.delete(l);
      },
    },
    equipment: {
      intervals: (_machine: string, from: Date, to: Date): Promise<StoredInterval[]> =>
        Promise.resolve(
          w.pieces
            .filter((p) => T0 + p.to * MIN > from.getTime() && T0 + p.from * MIN < to.getTime())
            .map((p) => ({
              equipment: 'cnc-01',
              epoch: 1,
              start: at(p.from),
              end: at(p.to),
              state: p.state,
              cause: null,
              hour: at(p.from),
              shiftKey: '2026-10-12/A',
              provisional: p.provisional === true,
              intervalStart: at(p.from),
              startSeq: null,
            })),
        ),
      onPiecesChanged: (l: () => void) => {
        listeners.pieces.add(l);
        return () => listeners.pieces.delete(l);
      },
    },
    ingest: {
      deviceProgress: (equipment: string) =>
        Promise.resolve({ equipment, epoch: 1, settledTime: w.finalThrough, settledSeq: 1 }),
    },
    masterData: {
      equipment: () => Promise.resolve([{ id: 'cnc-01', operation: 'OP10' }]),
    },
    shiftPattern: plant.shifts,
    config: plant.oee,
    idealCycleMs: idealCycleMs(plant),
    operations: plant.products.operations,
  } as unknown as OrderOeeOptions;
  return { options, listeners };
}

const read = async (w: World) => {
  const view = await new OrderOee(sources(w).options).order('A');
  if (!view) throw new Error('no view');
  return view;
};

describe('order OEE finality (#231)', () => {
  it('is final with every input final, and computes the job window from head time', async () => {
    const view = await read(world());
    expect([view.final, view.firstPassYield.final]).toEqual([true, true]);
    const [job] = view.jobs;
    expect(job?.head).toEqual({ kind: 'head', at: T0, source: 'accepted' });
    expect(job?.window).toMatchObject({ from: T0, to: T0 + 30 * MIN, open: false, lost: false });
    expect(job?.cycles).toBe(2);
    // PBT 30 min (the Setup counts against the order), APT 20 min, ideal 2 × 240 s.
    expect(view.result.order.totals).toMatchObject({
      plannedBusyMs: 1_800_000n,
      actualProductionMs: 1_200_000n,
      idealMs: 480_000n,
      good: 2n,
      produced: 2n,
    });
    expect(view.firstPassYield).toMatchObject({ firstPassGood: 2n, started: 2n, final: true });
    expect(view.cutoffs).toEqual([{ machine: 'cnc-01', epoch: 1, at: at(60) }]);
  });

  it('keeps it provisional while an input can still change', async () => {
    const cases: [string, (w: World) => void][] = [
      [
        'a piece in the window provisional',
        (w) => (w.pieces[1] = { from: 10, to: 30, state: 'Running', provisional: true }),
      ],
      ['a hole in the pieces', (w) => w.pieces.splice(1, 1)],
      ['a cycle not attributed yet', (w) => w.units.pop()],
      ['a cycle after the window', (w) => (w.units[1] = { commandId: 'A~OP10~1', op10: 45 })],
      ['execution behind the window', (w) => (w.processed = at(20))],
      ['the window open at the final-through', (w) => (w.finalThrough = at(25))],
      [
        'more blanks to dispatch',
        (w) => (w.order = { ...w.order, dispatched: 1, status: 'in-progress' }),
      ],
      [
        'an earlier command on the CNC not settled',
        (w) =>
          w.commands.unshift({
            commandId: 'B~OP10~1',
            orderId: 'B',
            settled: false,
            acceptedBy: null,
            acceptedSeq: null,
            acceptedAt: null,
            job: null,
          }),
      ],
      [
        'the order’s own command not settled',
        (w) => (w.commands[0] = { ...w.commands[0], settled: false }),
      ],
    ];
    for (const [label, change] of cases) {
      const w = world();
      change(w);
      const view = await read(w);
      expect([label, view.final]).toEqual([label, false]);
      expect(view.result.lost).toBe(false);
    }
    // The yield is final only once the order is complete.
    const w = world();
    w.completedAt = null;
    w.inMachine = 1;
    const view = await read(w);
    expect([view.final, view.firstPassYield.final, view.firstPassYield.started]).toEqual([
      true,
      false,
      3n,
    ]);
  });

  it('recovers a lost completion from the last cycle once the boundary is closed, and stays final', async () => {
    const w = world();
    w.commands[0] = { ...w.commands[0], completedAt: null };
    w.commands.push({ commandId: 'C~OP10~1', orderId: 'C', startedAt: at(40), completedAt: null });
    w.units.push({ commandId: 'C~OP10~1', op10: 55 });
    const view = await read(w);
    expect([view.final, view.result.lost]).toEqual([true, false]);
    expect(view.jobs[0]?.window).toMatchObject({ to: T0 + 30 * MIN, open: false, endLost: false });
  });

  it('is never final on a lost path', async () => {
    // A's `completed` fact written off (the next job started and the CNC is final past it), and
    // one of its cycles with it: its end is lost, the window capped at the next start.
    const w = world();
    w.commands[0] = { ...w.commands[0], completedAt: null };
    w.commands.push({ commandId: 'C~OP10~1', orderId: 'C', startedAt: at(40), completedAt: null });
    w.units = [
      { commandId: 'A~OP10~1', op10: 20 },
      { commandId: 'C~OP10~1', op10: 55 },
    ];
    const view = await read(w);
    expect([view.final, view.result.endLost, view.result.lost]).toEqual([false, true, true]);
    expect(view.jobs[0]?.window).toMatchObject({ to: T0 + 40 * MIN, endLost: true, lost: true });
    // A's acceptance lost: no fact, no result, the CNC final past its started fact.
    const v = world();
    v.commands[0] = {
      ...v.commands[0],
      acceptedBy: null,
      acceptedSeq: null,
      acceptedAt: null,
      settled: false,
    };
    const unknown = await read(v);
    expect([unknown.final, unknown.result.headTimeUnknown, unknown.result.lost]).toEqual([
      false,
      true,
      true,
    ]);
    expect(unknown.jobs[0]?.head).toEqual({ kind: 'unknown', reason: 'accepted-lost' });
  });

  it('keeps a final order in memory and follows the modules’ changes', async () => {
    const calls = { order: 0 };
    const { options, listeners } = sources(world(), calls);
    const oee = new OrderOee(options);
    const first = await oee.order('A');
    expect(await oee.order('A')).toBe(first);
    expect(calls.order).toBe(1);
    expect(await oee.order('Z')).toBeUndefined();
    const seen: (string | null)[] = [];
    oee.onChange((id) => seen.push(id));
    oee.onChange(() => {
      throw new Error('a listener’s failure stays with it');
    });
    oee.start();
    for (const l of listeners.orders) {
      l({ type: 'command', event: 'updated', command: commandRecord({}) });
      l({ type: 'order', event: 'updated', order: { id: 'A' } as OrderRecord });
      l({ type: 'operation', event: 'updated', operation: {} as never });
    }
    for (const l of listeners.execution) l({ type: 'order', orderId: 'B' });
    for (const l of listeners.pieces) l();
    expect(seen).toEqual([null, 'A', 'B', null]);
    oee.stop();
    expect(listeners.orders.size + listeners.execution.size + listeners.pieces.size).toBe(0);
  });
});
