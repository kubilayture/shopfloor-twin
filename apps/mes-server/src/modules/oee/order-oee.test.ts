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
import { formatFraction } from '@shopfloor/oee-core';
import {
  OrderOee,
  acceptanceCompare,
  processedThrough,
  type OrderOeeOptions,
} from './order-oee.ts';

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
  /** Sequence-gap incidents (written off) per machine and epoch (default 1), by plant time. */
  gaps: { machine: string; after: number; before: number; epoch?: number }[];
  /** A machine's own current device epoch, when it differs from `deviceEpoch`. */
  epochs: Record<string, number>;
  /** An `unknown-job` incident open on CNC-01. */
  unknownJob: boolean;
  /** Another kind of order incident open on CNC-01 (it doesn't block finality). */
  otherIncident: boolean;
  /** The highest revision of the hours under the view (`Equipment.revision`). */
  revision: number;
  /** The ranges `Equipment.revision` was asked for. */
  revisionReads: { machine: string; epoch: number; from: number; to: number }[];
  /** Pieces of ASM-01 (the bottleneck), by minutes. */
  bottleneck: World['pieces'];
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
    epochs: {},
    unknownJob: false,
    otherIncident: false,
    revision: 0,
    revisionReads: [],
    bottleneck: [{ from: 0, to: 120, state: 'Running' }],
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

function sources(w: World, calls = { order: 0, commands: 0, blanks: 0 }) {
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
        return Promise.resolve(
          id === w.order.id
            ? ({ ...w.order, completedAt: w.completedAt } as OrderRecord)
            : undefined,
        );
      },
      commands: () => {
        calls.commands++;
        return Promise.resolve(commands);
      },
      list: () =>
        Promise.resolve({
          orders: [{ ...w.order, completedAt: w.completedAt } as OrderRecord],
          truncated: false,
        }),
      incidents: () =>
        Promise.resolve([
          ...(w.unknownJob
            ? [{ id: 1, type: 'unknown-job', equipment: 'cnc-01', closedAt: null }]
            : []),
          ...(w.otherIncident
            ? [{ id: 2, type: 'command-unconfirmed', equipment: 'cnc-01', closedAt: null }]
            : []),
        ]),
      onChange: (l: (change: OrderChange) => void) => {
        listeners.orders.add(l);
        return () => listeners.orders.delete(l);
      },
    },
    execution: {
      units: ({ orderId }: { orderId?: string }) =>
        Promise.resolve({ units: units.filter((u) => u.orderId === orderId), truncated: false }),
      blanksInMachine: () => {
        calls.blanks++;
        return Promise.resolve({ 'cnc-01': w.inMachine });
      },
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
      revision: (machine: string, epoch: number, from: Date, to: Date) => {
        w.revisionReads.push({ machine, epoch, from: from.getTime(), to: to.getTime() });
        return Promise.resolve(w.revision);
      },
      watermarks: () => [],
      intervals: (
        machine: string,
        from: Date,
        to: Date,
        options: { state?: string } = {},
      ): Promise<StoredInterval[]> =>
        Promise.resolve(
          (machine === 'asm-01' ? w.bottleneck : w.pieces)
            .filter((p) => T0 + p.to * MIN > from.getTime() && T0 + p.from * MIN < to.getTime())
            .filter((p) => options.state === undefined || p.state === options.state)
            .map((p) => ({
              equipment: machine,
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
      deviceProgresses: (machines: readonly string[]) =>
        Promise.resolve(
          new Map(
            machines.map((equipment) => [
              equipment,
              {
                equipment,
                epoch: w.epochs[equipment] ?? w.deviceEpoch,
                settledTime: w.finalThrough,
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
                seqFrom: 10,
                seqTo: 11,
                after: at(g.after),
                before: at(g.before),
              })),
          ),
        ),
    },
    masterData: {
      equipment: () =>
        Promise.resolve(
          plant.plant.areas.flatMap((a) =>
            a.workCenters.flatMap((wc) =>
              wc.equipment.map((e) => ({ id: e.id, operation: e.operation })),
            ),
          ),
        ),
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
    const calls = { order: 0, commands: 0, blanks: 0 };
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
    const calls = { order: 0, commands: 0, blanks: 0 };
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

  it('ignores an order incident of another kind on the CNC (only `unknown-job` blocks)', async () => {
    const w = world();
    w.otherIncident = true;
    expect((await read(w)).final).toBe(true);
  });

  it('touches a gap exactly at the span’s edges, not one beyond them (#232)', async () => {
    // CNC-01: its window [0, 30] and its units' records span [20, 50] (to the completion).
    const w = world();
    w.gaps = [
      { machine: 'cnc-01', after: -10, before: 0 }, // ends exactly at the window's start
      { machine: 'cnc-01', after: 50, before: 60 }, // starts exactly at the completion
      { machine: 'cnc-01', after: -10, before: -1 / 60_000 }, // one ms before
      { machine: 'cnc-01', after: 50 + 1 / 60_000, before: 60 }, // one ms after
    ];
    expect((await read(w)).incidents.map((incident) => incident.id)).toEqual([1, 2]);
  });

  it('looks gaps up in each machine’s own device epoch, and in the unit’s run epoch when it differs (#232)', async () => {
    // The washer's stream (followed by part id) has an epoch of its own (7); the units carry the
    // CNC run's epoch 1, which a unit of an earlier run also needs.
    const w = world();
    w.epochs = { x: 7 };
    w.gaps = [
      { machine: 'x', after: 30, before: 31, epoch: 7 },
      { machine: 'x', after: 30, before: 31, epoch: 1 },
      { machine: 'x', after: 30, before: 31, epoch: 5 }, // neither
    ];
    expect((await read(w)).incidents).toEqual([
      { machine: 'x', epoch: 1, id: 1, seqFrom: 10, seqTo: 11 },
      { machine: 'x', epoch: 7, id: 1, seqFrom: 10, seqTo: 11 },
    ]);
    // The same epoch: looked up once.
    const same = world();
    same.gaps = [{ machine: 'x', after: 30, before: 31 }];
    expect((await read(same)).incidents).toEqual([
      { machine: 'x', epoch: 1, id: 1, seqFrom: 10, seqTo: 11 },
    ]);
  });

  it('looks gaps up on the bottleneck over the order’s whole in-progress time (#232)', async () => {
    // ASM-01 is visited by no unit here; its Maintenance is a planned stop of the order's line OEE.
    const w = world();
    w.gaps = [
      { machine: 'asm-01', after: 1, before: 2 }, // inside the in-progress time [0, 50]
      { machine: 'asm-01', after: 51, before: 52 }, // after it
    ];
    const view = await read(w);
    expect(view.incidents).toEqual([
      { machine: 'asm-01', epoch: 1, id: 1, seqFrom: 10, seqTo: 11 },
    ]);
    expect([view.mayRevise, view.line?.final]).toEqual([true, true]);
  });

  it('marks a view with incidents as revisable, with the hours’ revision (#232)', async () => {
    const w = world();
    w.revision = 3;
    const clean = await read(w);
    expect([clean.mayRevise, clean.revision]).toEqual([false, 0]);
    w.gaps = [{ machine: 'cnc-01', after: 15, before: 16 }];
    const revised = await read(w);
    expect([revised.final, revised.mayRevise, revised.revision]).toEqual([true, true, 3]);
  });

  it('lists an order’s jobs across CNCs by acceptance time, unknown last, then dispatch order', async () => {
    expect(
      [
        { id: 'c', acceptedAt: null, queuePosition: 1 },
        { id: 'b', acceptedAt: 20, queuePosition: 2 },
        { id: 'a', acceptedAt: 10, queuePosition: 9 },
        { id: 'd', acceptedAt: 20, queuePosition: 1 },
        { id: 'e', acceptedAt: null, queuePosition: 0 },
      ]
        .sort(acceptanceCompare)
        .map((c) => c.id),
    ).toEqual(['a', 'd', 'b', 'e', 'c']);
    // In a view: a second job on CNC-02, accepted before the first one on CNC-01.
    const w = world();
    w.order = { ...w.order, quantity: 4, dispatched: 4 };
    w.commands.push({
      commandId: 'A~OP10~2',
      orderId: 'A',
      equipment: 'cnc-02',
      acceptedAt: at(-5),
      startedAt: at(10),
      completedAt: at(30),
    });
    const view = await read(w);
    expect(view.jobs.map((job) => job.commandId)).toEqual(['A~OP10~2', 'A~OP10~1']);
  });

  it('processes a queue only in its own run or once execution is in a newer one', () => {
    const queue = { epoch: 2 };
    const to = T0 + 30 * MIN;
    // Execution a run behind the queue: never processed, however far it got.
    expect(processedThrough({ epoch: 1, settledTime: at(90) }, queue, to)).toBe(false);
    expect(processedThrough({ epoch: 3, settledTime: at(0) }, queue, to)).toBe(true);
    // Exactly through the window's end counts.
    expect(processedThrough({ epoch: 2, settledTime: new Date(to) }, queue, to)).toBe(true);
    expect(processedThrough({ epoch: 2, settledTime: new Date(to - 1) }, queue, to)).toBe(false);
    expect(processedThrough({ epoch: 2, settledTime: null }, queue, to)).toBe(false);
    expect(processedThrough({ epoch: null, settledTime: at(90) }, queue, to)).toBe(false);
    expect(processedThrough(undefined, queue, to)).toBe(false);
  });

  it('computes the order’s line OEE over its in-progress time (#232)', async () => {
    // Head 03:00Z, complete at 03:50Z: 3 000 000 ms planned (no break), two packs of VB-100 at
    // 03:25Z and 03:35Z × ASM-01's 150 000 ms = 300 000 ms ideal: 1/10.
    const view = await read(world());
    const line = view.line;
    expect([line?.open, line?.final]).toEqual([false, true]);
    expect(line?.value).toMatchObject({
      from: T0,
      to: T0 + 50 * MIN,
      through: T0 + 50 * MIN,
      plannedBusyMs: 3_000_000,
      good: { 'VB-100': 2 },
    });
    expect(line?.value.result.oee && formatFraction(line.value.result.oee)).toBe('1/10');
    // A pack exactly at the completion counts (every pack of the order, as the truth counts).
    const atEnd = world();
    atEnd.completedAt = at(35);
    expect((await read(atEnd)).line?.value.good).toEqual({ 'VB-100': 2 });
    // Only the order's own good records at the last operation are packs (#257): a scrap or a
    // rework at OP50 is none, nor is a good record at another operation (OP10 included).
    const mixed = world();
    mixed.units = [
      {
        commandId: 'A~OP10~1',
        op10: 20,
        records: [
          ['OP20', 'good'],
          ['OP50', 'scrap'],
        ],
      },
      {
        commandId: 'A~OP10~1',
        op10: 30,
        records: [
          ['OP50', 'rework'],
          ['OP50', 'good'],
        ],
      },
    ];
    expect((await read(mixed)).line?.value.good).toEqual({ 'VB-100': 1 });
    const none = world();
    none.units = [
      { commandId: 'A~OP10~1', op10: 20, records: [['OP40', 'good']] },
      { commandId: 'A~OP10~1', op10: 30, records: [['OP50', 'scrap']] },
    ];
    expect((await read(none)).line?.value.good).toEqual({});
    // Maintenance on the bottleneck is a planned stop: 2 400 000 ms, 1/8.
    const maintained = world();
    maintained.bottleneck = [
      { from: 0, to: 10, state: 'Running' },
      { from: 10, to: 20, state: 'Maintenance' },
      { from: 20, to: 120, state: 'Running' },
    ];
    const kept = (await read(maintained)).line?.value;
    expect([kept?.plannedBusyMs, kept && formatFraction(kept.result.idealMs)]).toEqual([
      2_400_000,
      '300000/1',
    ]);
    // A provisional bottleneck piece keeps it provisional.
    const moving = world();
    moving.bottleneck = [{ from: 0, to: 120, state: 'Running', provisional: true }];
    expect((await read(moving)).line?.final).toBe(false);
    // Open: to the cut-off (CNC-01's final-through, 04:00Z), not final.
    const open = world();
    open.completedAt = null;
    const value = (await read(open)).line;
    expect([value?.open, value?.final, value?.value.to, value?.value.plannedBusyMs]).toEqual([
      true,
      false,
      T0 + 60 * MIN,
      3_600_000,
    ]);
  });

  it('gives no line OEE before a job is head, and none from a head time after the cut-off', async () => {
    const w = world();
    w.commands[0] = {
      ...w.commands[0],
      notBefore: at(90),
      startedAt: null,
      completedAt: null,
    };
    w.units = [];
    w.completedAt = null;
    expect((await read(w)).line).toBeNull();
  });

  it('tells line OEE each order’s in-progress start and completion, and how far each CNC’s jobs are known (#232)', async () => {
    const oee = (w: World) => new OrderOee(sources(w).options);
    const done = await oee(world()).lineOrders();
    expect(done.orders).toEqual([
      { orderId: 'A', from: T0, completedAt: T0 + 50 * MIN, unknown: [] },
    ]);
    // Every job of CNC-01 completed: it holds nothing back.
    expect(done.cncThrough).toEqual(new Map([['cnc-01', Number.POSITIVE_INFINITY]]));
    // A job running: CNC-01's final-through (04:00Z).
    const running = world();
    running.commands[0] = { ...running.commands[0], completedAt: null };
    running.completedAt = null;
    expect((await oee(running).lineOrders()).cncThrough).toEqual(
      new Map([['cnc-01', at(60).getTime()]]),
    );
    // Accepted and waiting for a notBefore ahead: until its head time.
    const ahead = world();
    ahead.commands[0] = {
      ...ahead.commands[0],
      notBefore: at(300),
      startedAt: null,
      completedAt: null,
    };
    ahead.units = [];
    ahead.completedAt = null;
    const later = await oee(ahead).lineOrders();
    expect(later.cncThrough).toEqual(new Map([['cnc-01', at(300).getTime()]]));
    // A head time after the cut-off starts nothing.
    expect(later.orders).toEqual([{ orderId: 'A', from: null, completedAt: null, unknown: [] }]);
    // A job waiting behind another: listed with its predecessor's order.
    const behind = world();
    behind.commands[0] = { ...behind.commands[0], completedAt: null };
    behind.commands.push({
      commandId: 'B~OP10~1',
      orderId: 'B',
      startedAt: null,
      completedAt: null,
    });
    behind.completedAt = null;
    const waiting = await oee(behind).lineOrders();
    expect(waiting.orders.find((o) => o.orderId === 'B')?.unknown).toMatchObject([
      { commandId: 'B~OP10~1', reason: 'waiting', after: 'A', machine: 'cnc-01' },
    ]);
    // A newer device run: the old queue's jobs hold nothing back.
    const ended = world();
    ended.commands[0] = { ...ended.commands[0], completedAt: null };
    ended.deviceEpoch = 2;
    expect((await oee(ended).lineOrders()).cncThrough).toEqual(new Map());
  });

  it('keeps a final order in memory only once its line OEE is final too (#232)', async () => {
    const calls = { order: 0, commands: 0, blanks: 0 };
    const w = world();
    w.bottleneck = [{ from: 0, to: 120, state: 'Running', provisional: true }];
    const oee = new OrderOee(sources(w, calls).options);
    const first = await oee.order('A');
    expect([first?.final, first?.firstPassYield.final, first?.line?.final]).toEqual([
      true,
      true,
      false,
    ]);
    w.bottleneck = [{ from: 0, to: 120, state: 'Running' }];
    expect((await oee.order('A'))?.line?.final).toBe(true);
    await oee.order('A');
    expect(calls.commands).toBe(2);
  });

  it('reads the revision of every span through one ms past its end (#232)', async () => {
    // A span ending at an hour boundary (CNC-01's window ends 03:30Z, its units' span 03:50Z):
    // the hour starting at the end is read too, as a fact exactly at the end lies in it.
    const w = world();
    w.gaps = [{ machine: 'cnc-01', after: 15, before: 16 }];
    await read(w);
    expect(w.revisionReads.find((r) => r.machine === 'cnc-01')).toEqual({
      machine: 'cnc-01',
      epoch: 1,
      from: T0,
      to: T0 + 50 * MIN + 1,
    });
  });

  it('takes the completion from the order record and reads the blanks in a CNC only while open (#232)', async () => {
    const calls = { order: 0, commands: 0, blanks: 0 };
    const done = await new OrderOee(sources(world(), calls).options).order('A');
    expect([done?.completedAt?.getTime(), calls.blanks]).toEqual([T0 + 50 * MIN, 0]);
    const open = world();
    open.completedAt = null;
    open.inMachine = 1;
    const view = await new OrderOee(sources(open, calls).options).order('A');
    expect([view?.completedAt, view?.firstPassYield.started, calls.blanks]).toEqual([null, 3n, 1]);
  });

  it('tells line OEE the unknown-job CNCs, each unknown head’s notBefore, and an order’s earliest head across CNCs (#232)', async () => {
    const oee = (w: World) => new OrderOee(sources(w).options);
    // An open unknown-job incident on CNC-01 is reported; another kind of incident is not.
    const flagged = world();
    flagged.unknownJob = true;
    flagged.otherIncident = true;
    expect([...(await oee(flagged).lineOrders()).unknownJob]).toEqual(['cnc-01']);
    const other = world();
    other.otherIncident = true;
    expect([...(await oee(other).lineOrders()).unknownJob]).toEqual([]);
    // Unknown heads carry their notBefore: an acceptance not known yet, and a job waiting behind.
    const w = world();
    w.commands[0] = { ...w.commands[0], completedAt: null };
    w.completedAt = null;
    w.commands.push(
      {
        commandId: 'B~OP10~1',
        orderId: 'B',
        notBefore: at(70),
        startedAt: null,
        completedAt: null,
      },
      {
        commandId: 'C~OP10~1',
        orderId: 'C',
        equipment: 'cnc-02',
        notBefore: at(80),
        settled: false,
        acceptedBy: null,
        acceptedSeq: null,
        acceptedAt: null,
        job: null,
      },
    );
    const lines = await oee(w).lineOrders();
    expect(lines.orders.flatMap((o) => o.unknown)).toEqual([
      {
        orderId: 'B',
        commandId: 'B~OP10~1',
        machine: 'cnc-01',
        notBefore: at(70).getTime(),
        reason: 'waiting',
        after: 'A',
      },
      {
        orderId: 'C',
        commandId: 'C~OP10~1',
        machine: 'cnc-02',
        notBefore: at(80).getTime(),
        reason: 'accepted-unknown',
        after: null,
      },
    ]);
    // One order, two jobs on two CNCs with different head times: it starts at the earlier one,
    // in `lineOrders` and in its own line value (the minimum, not the maximum).
    const two = world();
    two.order = { ...two.order, quantity: 4, dispatched: 4 };
    two.commands[0] = { ...two.commands[0], acceptedAt: at(10) };
    two.commands.push({
      commandId: 'A~OP10~2',
      orderId: 'A',
      equipment: 'cnc-02',
      acceptedAt: at(5),
      startedAt: at(10),
      completedAt: at(30),
    });
    const start = (await oee(two).lineOrders()).orders.find((o) => o.orderId === 'A')?.from;
    expect(start).toBe(at(5).getTime());
    expect((await read(two)).line?.value.from).toBe(at(5).getTime());
  });
});
