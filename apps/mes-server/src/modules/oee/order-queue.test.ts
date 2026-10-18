import { jobWindows } from '@shopfloor/oee-core';
import { describe, expect, it } from 'vitest';
import type { StoredInterval } from '../equipment/index.ts';
import { piecesFinal, wholeIntervals } from './order-oee.ts';
import {
  acceptanceOrder,
  commandQueues,
  inQueue,
  orderSlice,
  queuedJob,
  type CommandQueue,
  type DeviceCut,
  type QueueCommand,
} from './order-queue.ts';

const MIN = 60_000;
const T = Date.parse('2026-10-12T03:00:00.000Z');
const at = (minutes: number): number => T + minutes * MIN;

let position = 0;
function command(id: string, over: Partial<QueueCommand> = {}): QueueCommand {
  position += 1;
  return {
    commandId: id,
    orderId: id.split('~')[0] ?? id,
    equipment: 'cnc-01',
    deviceEpoch: 1,
    quantity: 2,
    notBefore: T,
    queuePosition: position,
    settled: true,
    acceptedBy: 'fact',
    acceptedSeq: position,
    acceptedAt: at(0),
    jobLost: false,
    startedAt: null,
    completedAt: null,
    ...over,
  };
}

const cut = (finalThrough: number | null, epoch = 1): DeviceCut => ({ epoch, finalThrough });
const queueOf = (commands: QueueCommand[], c: DeviceCut = cut(at(1_000))): CommandQueue => {
  const [queue] = commandQueues(commands, new Map([['cnc-01', c]]));
  if (!queue) throw new Error('no queue');
  return queue;
};

describe('the CNC queue from the command state (#231, ADR-0036 queue contract)', () => {
  it('holds every command whose acceptance is not refuted', () => {
    expect(inQueue(command('A~OP10~1'))).toBe(true);
    // Acceptance unknown: not settled yet (sent, failed, a conflict) — in the queue.
    expect(
      inQueue(
        command('B~OP10~1', {
          acceptedBy: null,
          acceptedSeq: null,
          acceptedAt: null,
          settled: false,
        }),
      ),
    ).toBe(true);
    // Settled without a job (rejected, expired, not accepted, its run ended unanswered): refuted.
    expect(
      inQueue(command('C~OP10~1', { acceptedBy: null, acceptedSeq: null, acceptedAt: null })),
    ).toBe(false);
    // Job facts without an acceptance: the job exists.
    expect(
      inQueue(
        command('D~OP10~1', {
          acceptedBy: null,
          acceptedSeq: null,
          acceptedAt: null,
          startedAt: at(5),
        }),
      ),
    ).toBe(true);
  });

  it('orders by acceptance, keeping a command of unknown acceptance at its dispatch place', () => {
    const a = command('A~OP10~1', { acceptedSeq: 30 });
    const b = command('B~OP10~1', {
      acceptedBy: null,
      acceptedSeq: null,
      acceptedAt: null,
      settled: false,
    });
    const c = command('C~OP10~1', { acceptedSeq: 10 });
    const d = command('D~OP10~1', { acceptedSeq: 20 });
    expect(acceptanceOrder([d, c, b, a]).map((x) => x.commandId)).toEqual([
      'C~OP10~1',
      'B~OP10~1',
      'D~OP10~1',
      'A~OP10~1',
    ]);
  });

  it('groups per CNC and device epoch; the cut-off is the final-through, or the run’s last time once it ended', () => {
    const queues = commandQueues(
      [
        command('A~OP10~1', { completedAt: at(50) }),
        command('B~OP10~1', { equipment: 'cnc-02' }),
        command('C~OP10~1', { deviceEpoch: 2 }),
        command('X~OP10~1', { acceptedBy: null, acceptedSeq: null, acceptedAt: null }),
      ],
      new Map([
        ['cnc-01', cut(at(60), 2)],
        ['cnc-02', cut(null, 1)],
      ]),
    );
    expect(
      queues.map((q) => [q.machine, q.epoch, q.ended, q.until, q.commands.map((c) => c.commandId)]),
    ).toEqual([
      ['cnc-01', 1, true, at(50), ['A~OP10~1']],
      ['cnc-02', 1, false, 0, ['B~OP10~1']],
      ['cnc-01', 2, false, at(60), ['C~OP10~1']],
    ]);
  });

  it('maps the acceptance: the fact as `accepted`, the command result as `acceptedAt`', () => {
    const q = queueOf([
      command('A~OP10~1', { acceptedAt: at(1) }),
      command('B~OP10~1', { acceptedBy: 'result', acceptedAt: at(2), notBefore: at(30) }),
    ]);
    expect(queuedJob(q, 0, cut(at(1_000)))).toEqual({
      id: 'A~OP10~1',
      machine: 'cnc-01',
      accepted: at(1),
      notBefore: T,
      quantity: 2,
    });
    expect(queuedJob(q, 1, cut(at(1_000)), [at(40)])).toMatchObject({
      acceptedAt: at(2),
      notBefore: at(30),
      cycleEnds: [at(40)],
    });
    expect(() => queuedJob(q, 5, cut(0))).toThrow(/no command 5/);
  });

  it('calls an acceptance lost only once the final-through passed the job’s first fact', () => {
    const job = command('A~OP10~1', {
      acceptedBy: null,
      acceptedSeq: null,
      acceptedAt: null,
      settled: false,
      startedAt: at(10),
    });
    // Not received yet (the final-through still before the started fact): transient.
    expect(queuedJob(queueOf([job], cut(at(10))), 0, cut(at(10))).acceptedLost).toBeUndefined();
    // Past it: the accepted fact (before `started` on the device) was written off.
    expect(queuedJob(queueOf([job], cut(at(11))), 0, cut(at(11))).acceptedLost).toBe(true);
    // Its run ended: lost too.
    const ended = queueOf([job], cut(at(5), 2));
    expect(queuedJob(ended, 0, cut(at(5), 2)).acceptedLost).toBe(true);
  });

  it('calls a completion lost past the next start, past the last cycle with nothing after, or when the run ended', () => {
    const a = command('A~OP10~1', { startedAt: at(5) });
    const b = command('B~OP10~1', { startedAt: at(40) });
    // The next job started and the CNC is final past it: A's `completed` was written off.
    expect(queuedJob(queueOf([a, b], cut(at(41))), 0, cut(at(41))).completedLost).toBe(true);
    expect(queuedJob(queueOf([a, b], cut(at(40))), 0, cut(at(40))).completedLost).toBeUndefined();
    // No next job: once every cycle is known and the final-through passed the last one.
    const alone = queueOf([a], cut(at(31)));
    expect(queuedJob(alone, 0, cut(at(31)), [at(20), at(30)]).completedLost).toBe(true);
    expect(queuedJob(alone, 0, cut(at(31)), [at(20)]).completedLost).toBeUndefined();
    expect(queuedJob(alone, 0, cut(at(30)), [at(20), at(30)]).completedLost).toBeUndefined();
    expect(queuedJob(alone, 0, cut(at(31))).completedLost).toBeUndefined();
    // The run ended, or the orders module says the job was lost with it.
    expect(queuedJob(queueOf([a], cut(at(6), 2)), 0, cut(at(6), 2)).completedLost).toBe(true);
    const lost = command('C~OP10~1', { jobLost: true });
    expect(queuedJob(queueOf([lost]), 0, cut(at(1_000))).completedLost).toBe(true);
    // A completed job is never lost.
    const done = command('D~OP10~1', { startedAt: at(5), completedAt: at(30) });
    expect(
      queuedJob(queueOf([done], cut(at(6), 2)), 0, cut(at(6), 2)).completedLost,
    ).toBeUndefined();
  });

  it('keeps a job of unknown acceptance in the queue, so its predecessor’s boundary stays open (H16)', () => {
    // J1's last cycle, its `completed`, J2's `accepted` and `started` all missing; J2's cycles
    // reach J1 by the started-fact rule. With J2 in the queue (from its command), J1's window has
    // no recovered completion; from job facts alone J1 would end at J2's last cycle.
    const j1 = command('J1~OP10~1', { startedAt: at(5), quantity: 2 });
    const j2 = command('J2~OP10~1', {
      acceptedBy: null,
      acceptedSeq: null,
      acceptedAt: null,
      settled: false,
      quantity: 2,
    });
    const ends = [at(20), at(50)]; // J1's first cycle and one of J2's
    const full = queueOf([j1, j2], cut(at(55)));
    const jobs = [queuedJob(full, 0, cut(at(55)), ends), queuedJob(full, 1, cut(at(55)), [])];
    const [w1] = jobWindows(jobs, at(55), 'cnc-01');
    expect(w1?.window).toMatchObject({ to: at(55), open: true, endLost: false });
    const alone = queueOf([j1], cut(at(55)));
    const [wrong] = jobWindows(
      [{ ...queuedJob(alone, 0, cut(at(55)), ends), completedLost: true }],
      at(55),
      'cnc-01',
    );
    expect(wrong?.window).toMatchObject({ to: at(50), open: false });
  });

  it('slices the queue around an order’s jobs (predecessor and successor)', () => {
    const q = queueOf([
      command('A~OP10~1'),
      command('B~OP10~1'),
      command('C~OP10~1'),
      command('C~OP10~2'),
      command('D~OP10~1'),
      command('E~OP10~1'),
    ]);
    expect(orderSlice(q, 'C')).toEqual({ from: 1, to: 5 });
    expect(orderSlice(q, 'A')).toEqual({ from: 0, to: 2 });
    expect(orderSlice(q, 'E')).toEqual({ from: 4, to: 6 });
    expect(orderSlice(q, 'Z')).toEqual({ from: 0, to: 0 });
  });
});

const piece = (
  from: number,
  to: number,
  start: number,
  state: string,
  provisional = false,
): StoredInterval => ({
  equipment: 'cnc-01',
  epoch: 1,
  start: new Date(from),
  end: new Date(to),
  state,
  cause: null,
  hour: new Date(from),
  shiftKey: '2026-10-12/A',
  provisional,
  intervalStart: new Date(start),
  startSeq: null,
});

describe('whole intervals from stored pieces (#231)', () => {
  it('joins pieces of one interval (cut at hours) and marks one with a provisional piece open', () => {
    const pieces = [
      piece(at(50), at(60), at(50), 'Stopped'),
      piece(at(60), at(61), at(50), 'Stopped'),
      piece(at(61), at(70), at(61), 'Running', true),
    ];
    expect(wholeIntervals(pieces)).toEqual([
      { from: at(50), to: at(61), state: 'Stopped', cause: null },
      { from: at(61), to: at(70), state: 'Running', cause: null, open: true },
    ]);
  });

  it('is final only when the pieces cover the window and none is provisional', () => {
    const window = { from: at(55), to: at(65) };
    expect(
      piecesFinal(
        [piece(at(50), at(60), at(50), 'Running'), piece(at(60), at(70), at(60), 'Idle')],
        window,
      ),
    ).toBe(true);
    expect(piecesFinal([piece(at(50), at(60), at(50), 'Running')], window)).toBe(false);
    expect(
      piecesFinal(
        [piece(at(50), at(60), at(50), 'Running'), piece(at(60), at(70), at(60), 'Idle', true)],
        window,
      ),
    ).toBe(false);
    // A provisional piece outside the window doesn't matter.
    expect(
      piecesFinal(
        [piece(at(50), at(70), at(50), 'Running'), piece(at(70), at(80), at(70), 'Idle', true)],
        window,
      ),
    ).toBe(true);
  });
});
