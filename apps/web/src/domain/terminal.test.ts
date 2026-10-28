import { PROBLEM_TYPES } from '@shopfloor/contracts/mes-api';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client.ts';
import { answerOf, operationOf, orderOf, viewOf } from '../test/terminal-fixtures.ts';
import {
  codableReasons,
  myActivity,
  operationActions,
  signedOnHere,
  splitOrders,
  terminalFailure,
  withOperation,
  withoutScrapRecord,
} from './terminal.ts';

const activity = (userId: number, kind: 'work' | 'pause') => ({
  id: userId * 10,
  orderId: 'O-1',
  operation: 'OP30',
  workCenter: 'line-a1',
  userId,
  username: `u${String(userId)}`,
  kind,
  reason: kind === 'pause' ? ('break' as const) : null,
  comment: null,
  from: '2026-10-15T04:00:00.000Z',
  fromPlant: '2026-10-15T04:00:00.000Z',
  to: null,
  toPlant: null,
  endReason: null,
});

describe('terminal actions (#177)', () => {
  it('offers start, pause, resume and sign-off by the operator’s own interval and the operation', () => {
    const idle = operationOf('OP30');
    expect(operationActions(idle, 'in-progress', 1)).toEqual({
      start: true,
      pause: false,
      resume: false,
      signOff: false,
    });
    const working = operationOf('OP30', {
      activities: [activity(1, 'work'), activity(2, 'pause')],
    });
    expect(myActivity(working, 2)?.kind).toBe('pause');
    expect(operationActions(working, 'in-progress', 1)).toMatchObject({
      start: false,
      pause: true,
    });
    expect(operationActions(working, 'in-progress', 2)).toMatchObject({
      resume: true,
      pause: false,
    });
    // Someone else working does not stop this operator from starting.
    expect(operationActions(working, 'in-progress', 3).start).toBe(true);
    expect(operationActions(operationOf('OP30', { complete: true }), 'completed', 1).signOff).toBe(
      true,
    );
    const signed = operationOf('OP30', {
      complete: true,
      signedOff: {
        username: 'u1',
        at: '2026-10-15T05:00:00.000Z',
        plantAt: '2026-10-15T05:00:00.000Z',
      },
    });
    expect(Object.values(operationActions(signed, 'completed', 1))).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(Object.values(operationActions(idle, 'closed', 1))).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(Object.values(operationActions(idle, 'released', 1))).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  it('applies a write’s answer and a coding to the view shown', () => {
    const view = viewOf();
    const next = withOperation(view, answerOf('OP40', { version: 7 }));
    expect(next.orders[0]?.operations.map((o) => o.version)).toEqual([1, 7, 1]);
    // Counts are not part of the answer: the shown ones stay.
    expect(next.orders[0]?.operations[1]?.counts.in).toBe(2);
    expect(withoutScrapRecord(view, 11).scrapRecords).toEqual([]);
    expect(signedOnHere(viewOf({ crew: [] }), 1)).toBe(false);
  });

  it('lists the machine reason and those below it, active only', () => {
    const reasons = [
      { id: 'LEAK', parent: null, name: 'Leak', active: true },
      { id: 'LEAK/POROSITY', parent: 'LEAK', name: 'Porosity', active: true },
      { id: 'LEAK/OLD', parent: 'LEAK', name: 'Old', active: false },
      { id: 'LEAKY', parent: null, name: 'Not below', active: true },
      { id: 'DIMENSIONAL', parent: null, name: 'Dimensional', active: true },
    ];
    expect(codableReasons(reasons, 'LEAK').map((r) => r.id)).toEqual(['LEAK', 'LEAK/POROSITY']);
  });

  it('says why the MES refused a terminal write', () => {
    const conflict = (type: string, detail = 'detail') =>
      new ApiError('conflict', 409, {
        type,
        title: 'Conflict',
        status: 409,
        detail,
        instance: '/x',
      });
    expect(terminalFailure(conflict(PROBLEM_TYPES.operationStale), 'Not started').text).toMatch(
      /^Not started: someone changed this operation/,
    );
    expect(
      terminalFailure(conflict(PROBLEM_TYPES.operationState, 'not complete yet'), 'Not signed off')
        .text,
    ).toBe('Not signed off: not complete yet');
    expect(terminalFailure(conflict(PROBLEM_TYPES.noShift), 'Not signed on').text).toMatch(
      /no shift/,
    );
    expect(terminalFailure(new ApiError('down', 0), 'Not paused').kind).toBe('unavailable');
  });
});

describe('splitOrders (UX-7 review)', () => {
  const signed = {
    username: 'olga',
    at: '2026-10-15T06:00:00.000Z',
    plantAt: '2026-10-15T06:00:00.000Z',
  };
  const order = (
    id: string,
    status: 'in-progress' | 'completed' | 'closed' | 'dispatched',
    signedOff: boolean[],
  ) => ({
    order: orderOf(id, { status }),
    operations: signedOff.map((s, i) =>
      operationOf(`OP${String(i + 3)}0`, { signedOff: s ? signed : null }),
    ),
    wip: 0,
  });
  const ids = (os: readonly { order: { id: string } }[]) => os.map((o) => o.order.id);

  it('puts orders in progress first, and finished ones (all signed off) apart', () => {
    const { active, done } = splitOrders([
      order('A', 'completed', [true, true]),
      order('B', 'dispatched', [false]),
      order('C', 'completed', [true, false]),
      order('D', 'in-progress', [false, false]),
      order('E', 'closed', [true]),
      order('F', 'in-progress', [true]),
    ]);
    expect(ids(active)).toEqual(['D', 'F', 'B', 'C']);
    expect(ids(done)).toEqual(['A', 'E']);
  });

  it('keeps an order seen active with the active ones, and never calls one without operations done', () => {
    const { active, done } = splitOrders(
      [order('A', 'completed', [true]), order('G', 'completed', [])],
      new Set(['A']),
    );
    expect(ids(active)).toEqual(['A', 'G']);
    expect(done).toEqual([]);
  });
});
