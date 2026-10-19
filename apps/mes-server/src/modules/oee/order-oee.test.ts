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
  /** `start`: the interval's start when the piece is a later piece of it (cut at an hour). */
  pieces: { from: number; to: number; state: string; provisional?: boolean; start?: number }[];
  units: { commandId: string; op10: number; records?: [string, 'good' | 'scrap' | 'rework'][] }[];
  completedAt: Date | null;
  inMachine: number;
  finalThrough: Date | null;
  processed: Date | null;
  /** The CNC's current device epoch, and the one execution's last round processed. */
  deviceEpoch: number;
  processedEpoch: number;
  /** Sequence-gap incidents (written off) per machine, by plant time. */
  gaps: { machine: string; after: number; before: number }[];
  /** An `unknown-job` incident open on CNC-01. */
  unknownJob: boolean;
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
    deviceEpoch: 1,
    processedEpoch: 1,
    gaps: [],
    unknownJob: false,
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

function sources(w: World, calls = { order: 0, commands: 0 }) {
  const listeners = {
    orders: new Set<(change: OrderChange) => void>(),
    execution: new Set<(change: { type: 'order'; orderId: string }) => void>(),
    pieces: new Set<(change: { equipment: string }) => void>(),
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
      commands: () => {
        calls.commands++;
        return Promise.resolve(commands);
      },
      incidents: () =>
        Promise.resolve(
          w.unknownJob ? [{ id: 1, type: 'unknown-job', equipment: 'cnc-01', closedAt: null }] : [],
        ),
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
          [
            'cnc-01',
            {
              equipment: 'cnc-01',
              epoch: w.processedEpoch,
              settledTime: w.processed,
              settledSeq: 1,
            },
          ],
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
              intervalStart: at(p.start ?? p.from),
              startSeq: null,
            })),
        ),
      onPiecesChanged: (l: (change: { equipment: string }) => void) => {
        listeners.pieces.add(l);
        return () => listeners.pieces.delete(l);
      },
    },
    ingest: {
      deviceProgress: (equipment: string) =>
        Promise.resolve({
          equipment,
          epoch: w.deviceEpoch,
          settledTime: w.finalThrough,
          settledSeq: 1,
        }),
      settled: (machine: string) =>
        Promise.resolve({
          settledSeq: 1,
          settledTime: w.finalThrough,
          incidents: w.gaps
            .filter((g) => g.machine === machine)
            .map((g, i) => ({
              id: i + 1,
              seqFrom: 10,
              seqTo: 11,
              after: at(g.after),
              before: at(g.before),
            })),
        }),
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
        // B's facts are known (A's head time from B's completion is exact), but B, dispatched
        // earlier to the CNC, is not settled: `settledBefore` alone keeps A provisional.
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
            startedAt: at(-30),
            completedAt: at(-5),
          }),
      ],
      [
        'a command of the order in flight',
        (w) => (w.order = { ...w.order, inFlight: 2, status: 'in-progress' }),
      ],
      [
        'a failed dispatch',
        (w) => (w.order = { ...w.order, dispatchFailed: true, status: 'in-progress' }),
      ],
      ['a lost dispatch', (w) => (w.order = { ...w.order, dispatchLost: true })],
      ['a cycle before the window', (w) => (w.units[0] = { commandId: 'A~OP10~1', op10: -5 })],
      [
        // The window's part of the Running interval is final, but the interval goes on (open).
        'an open interval overlapping the window',
        (w) =>
          w.pieces.splice(
            1,
            2,
            { from: 10, to: 30, state: 'Running' },
            { from: 30, to: 40, state: 'Running', start: 10, provisional: true },
          ),
      ],
      ['an unknown-job incident on the CNC', (w) => (w.unknownJob = true)],
      [
        // An impossible reading (accepted but not settled): the defensive `command.settled`.
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
    const calls = { order: 0, commands: 0 };
    const w = world();
    const { options, listeners } = sources(w, calls);
    const oee = new OrderOee(options);
    const first = await oee.order('A');
    expect(first?.incidents).toEqual([]);
    // From memory: no command read again, but the status and the cut-off read on every hit.
    w.order = { ...w.order, status: 'closed' };
    w.finalThrough = at(90);
    const again = await oee.order('A');
    expect(calls.commands).toBe(1);
    expect(again?.status).toBe('closed');
    expect(again?.cutoffs).toEqual([{ machine: 'cnc-01', epoch: 1, at: at(90) }]);
    expect({ ...again, status: first?.status, cutoffs: first?.cutoffs }).toEqual(first);
    expect(await oee.order('Z')).toBeUndefined();
    const seen: unknown[] = [];
    oee.onChange((change) => seen.push(change));
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
    for (const l of listeners.pieces) l({ equipment: 'cnc-02' });
    expect(seen).toEqual([
      { machine: 'cnc-01' },
      { orderId: 'X' },
      { orderId: 'A' },
      { orderId: 'B' },
      { machine: 'cnc-02' },
    ]);
    oee.stop();
    expect(listeners.orders.size + listeners.execution.size + listeners.pieces.size).toBe(0);
  });

  it('makes a job of an ended run final once execution is in the newer run', async () => {
    const w = world();
    w.deviceEpoch = 2;
    w.processedEpoch = 2;
    w.processed = at(5);
    const view = await read(w);
    expect([view.final, view.result.lost]).toEqual([true, false]);
    // The ended queue's cut-off is its last known time; execution still in the old run: not final.
    expect(view.cutoffs).toEqual([{ machine: 'cnc-01', epoch: 1, at: at(30) }]);
    w.processedEpoch = 1;
    expect((await read(w)).final).toBe(false);
  });

  it('counts a blank held when a device run ended in the yield’s denominator', async () => {
    const w = world();
    w.commands[0] = { ...w.commands[0], job: 'lost', lostStarted: 3, completedAt: null };
    w.deviceEpoch = 2;
    const view = await read(w);
    expect(view.firstPassYield.started).toBe(3n);
    expect(view.final).toBe(false);
  });

  it('recomputes the same final value after a restart (a fresh module, nothing in memory)', async () => {
    const before = await read(world());
    const after = await read(world());
    expect(before.final).toBe(true);
    expect(after).toEqual(before);
  });

  it('classifies a Stopped interval by its whole length, read past the window’s end', async () => {
    // Stopped 29:00–31:00 (two pieces, cut at 30:30): 2 min whole, at the threshold, so a long
    // stop; read only to the window's end (30:00) it would be a 1.5 min micro-stop.
    const w = world();
    w.pieces = [
      { from: 0, to: 10, state: 'Setup' },
      { from: 10, to: 29, state: 'Running' },
      { from: 29, to: 30.5, state: 'Stopped' },
      { from: 30.5, to: 31, state: 'Stopped', start: 29 },
      { from: 31, to: 60, state: 'Idle' },
    ];
    w.units[1] = { commandId: 'A~OP10~1', op10: 29 };
    const view = await read(w);
    expect(view.result.order.totals).toMatchObject({ longStopMs: 60_000n, microStopMs: 0n });
    expect(view.final).toBe(true);
  });

  it('lists the written-off gaps the order’s inputs touch, and never keeps such a view', async () => {
    const calls = { order: 0, commands: 0 };
    const w = world();
    w.gaps = [
      { machine: 'cnc-01', after: 15, before: 16 }, // inside the window
      { machine: 'x', after: 30, before: 31 }, // in the units' span on OP50
      { machine: 'cnc-01', after: 70, before: 71 }, // after everything
    ];
    const oee = new OrderOee(sources(w, calls).options);
    const view = await oee.order('A');
    expect(view?.incidents).toEqual([
      { machine: 'cnc-01', epoch: 1, id: 1, seqFrom: 10, seqTo: 11 },
      { machine: 'x', epoch: 1, id: 1, seqFrom: 10, seqTo: 11 },
    ]);
    expect([view?.final, view?.firstPassYield.final]).toEqual([true, true]);
    await oee.order('A');
    expect(calls.commands).toBe(2);
  });
});
