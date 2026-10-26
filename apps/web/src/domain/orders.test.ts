import { PROBLEM_TYPES } from '@shopfloor/contracts/mes-api';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client.ts';
import { EQUIPMENT } from '../test/fixtures.ts';
import { ORDER_EQUIPMENT, ROUTING, command, order, pushedCommand } from '../test/order-fixtures.ts';
import {
  availableActions,
  canAbandon,
  countsText,
  dispatchTargets,
  draftFor,
  draftProblems,
  erpStatusTone,
  filterStatuses,
  flagTexts,
  isDirtyDraft,
  isOverdue,
  isStaleDraft,
  mergeCommands,
  mergeOrders,
  newestOrder,
  orderCodeWords,
  orderFailure,
  priorityGlyph,
  unsettledCommands,
} from './orders.ts';

const conflict = (type: string) =>
  new ApiError('Conflict', 409, {
    type,
    title: 'Conflict',
    status: 409,
    detail: 'd',
    instance: '/x',
  });

describe('orders domain', () => {
  it('offers the writes each status allows', () => {
    expect(availableActions(order('A', { status: 'imported' }))).toEqual(['release', 'cancel']);
    expect(availableActions(order('A', { status: 'released' }))).toEqual(['dispatch', 'cancel']);
    expect(availableActions(order('A', { status: 'in-progress', remaining: 3 }))).toEqual([
      'redispatch',
    ]);
    expect(availableActions(order('A', { status: 'dispatched', remaining: 0 }))).toEqual([]);
    expect(availableActions(order('A', { status: 'completed' }))).toEqual(['close']);
    for (const status of ['closed', 'cancelled', 'rejected'] as const) {
      expect(availableActions(order('A', { status }))).toEqual([]);
    }
  });

  it('offers abandon only for a command of an ended run on an open order', () => {
    const running = order('A', { status: 'in-progress' });
    expect(canAbandon(running, command('A', 1, { state: 'epoch-ended', job: null }))).toBe(true);
    expect(canAbandon(running, command('A', 1, { job: 'lost' }))).toBe(true);
    expect(canAbandon(running, command('A', 1, { state: 'abandoned', job: 'lost' }))).toBe(false);
    expect(canAbandon(running, command('A', 1, { state: 'unknown', job: null }))).toBe(false);
    expect(canAbandon(running, command('A', 1, { state: 'rejected', job: null }))).toBe(false);
    expect(canAbandon(order('A', { status: 'completed' }), command('A', 1, { job: 'lost' }))).toBe(
      false,
    );
  });

  it('lists the unsettled commands a re-dispatch waits for', () => {
    const settled = command('A', 1);
    const open = command('A', 2, { state: 'failed', settled: false });
    expect(unsettledCommands([settled, open]).map((c) => c.n)).toEqual([2]);
  });

  it('merges pushed orders into the read list, filtered and by planned start', () => {
    const late = order('B', { plannedStart: '2026-10-15T09:00:00.000Z' });
    const early = order('A', { plannedStart: '2026-10-15T07:00:00.000Z', version: 2 });
    const merged = mergeOrders(
      [late, early],
      {
        A: { ...early, version: 1, status: 'cancelled' },
        C: order('C', { plannedStart: '2026-10-15T08:00:00.000Z' }),
        D: order('D', { status: 'closed' }),
      },
      filterStatuses('open'),
    );
    expect(merged.map((o) => [o.id, o.status])).toEqual([
      ['A', 'imported'],
      ['C', 'imported'],
      ['B', 'imported'],
    ]);
    expect(filterStatuses(undefined)).toEqual([]);
    expect(filterStatuses('closed')).toEqual(['closed']);
  });

  it('keeps the read at an equal version and updatedAt, a later push otherwise', () => {
    const read = order('A', { version: 3, dispatched: 20 });
    expect(newestOrder(read, { ...read, dispatched: 0 })).toBe(read);
    const later = { ...read, dispatched: 0, updatedAt: '2026-10-15T07:00:00.000Z' };
    expect(newestOrder(read, later)).toBe(later);
    expect(newestOrder(read, { ...read, version: 2 })).toBe(read);
    const sent = command('A', 1, { state: 'sent' });
    // A push of the same command at the same updatedAt never hides the read's results.
    expect(mergeCommands('A', [sent], { [sent.commandId]: pushedCommand(sent) })[0]).toBe(sent);
  });

  it('leaves out pushed-only orders after the last one of a truncated read', () => {
    const a = order('A', { plannedStart: '2026-10-15T07:00:00.000Z' });
    const pushed = {
      B: order('B', { plannedStart: '2026-10-15T06:00:00.000Z' }),
      C: order('C', { plannedStart: '2026-10-15T09:00:00.000Z' }),
    };
    expect(mergeOrders([a], pushed, [], true).map((o) => o.id)).toEqual(['B', 'A']);
    expect(mergeOrders([a], pushed, [], false).map((o) => o.id)).toEqual(['B', 'A', 'C']);
  });

  it('overlays newer pushed commands of the order and adds new ones', () => {
    const first = command('A', 1, { state: 'sent' });
    const merged = mergeCommands('A', [first], {
      'A~OP10~1': pushedCommand({
        ...first,
        state: 'accepted',
        updatedAt: '2026-10-15T07:00:00.000Z',
      }),
      'A~OP10~2': pushedCommand(command('A', 2, { state: 'queued' })),
      'B~OP10~1': pushedCommand(command('B', 1)),
    });
    expect(merged.map((c) => [c.commandId, c.state, c.results.length])).toEqual([
      ['A~OP10~1', 'accepted', 1],
      ['A~OP10~2', 'queued', 0],
    ]);
  });

  it('offers the OP10 machines of the routing as dispatch targets', () => {
    expect(dispatchTargets(ORDER_EQUIPMENT, ROUTING).map((e) => e.id)).toEqual([
      'cnc-01',
      'cnc-02',
    ]);
    expect(dispatchTargets(EQUIPMENT, []).map((e) => e.id)).toEqual(['cnc-01']);
  });

  it('keeps the version a draft started from and checks its fields', () => {
    const base = order('A', { status: 'in-progress', remaining: 5, version: 4 });
    const draft = draftFor('redispatch', base);
    expect(isStaleDraft(draft, base)).toBe(false);
    expect(isStaleDraft(draft, { ...base, version: 5 })).toBe(true);
    expect(isDirtyDraft(draft)).toBe(false);
    expect(isDirtyDraft({ ...draft, quantity: '2' })).toBe(true);
    expect(draftProblems({ ...draft, quantity: '0' }, base)).toHaveLength(1);
    expect(draftProblems({ ...draft, quantity: '2.5' }, base)).toHaveLength(1);
    expect(draftProblems({ ...draft, quantity: '6' }, base)[0]).toContain('5 blanks');
    expect(draftProblems({ ...draft, quantity: '5' }, base)).toEqual([]);
    for (const quantity of ['1e1', '0x2', '+3', '-1', '3 4']) {
      expect(draftProblems({ ...draft, quantity }, base)).toHaveLength(1);
    }
    expect(
      draftProblems({ ...draftFor('cancel', base), reason: 'x'.repeat(501) }, base),
    ).toHaveLength(1);
  });

  it("names the orders module's refusals with their problem types", () => {
    expect(orderFailure(conflict(PROBLEM_TYPES.orderStale))).toMatchObject({
      kind: 'stale',
      type: PROBLEM_TYPES.orderStale,
    });
    expect(orderFailure(conflict(PROBLEM_TYPES.orderState)).kind).toBe('state');
    expect(orderFailure(conflict(PROBLEM_TYPES.commandsUnsettled)).kind).toBe('unsettled');
    // #177: a close before every operation is signed off says so, with the MES's list.
    const signOff = orderFailure(conflict(PROBLEM_TYPES.signOffMissing));
    expect(signOff).toMatchObject({ kind: 'sign-off', type: PROBLEM_TYPES.signOffMissing });
    expect(signOff.text).toMatch(/^Not closed: not every operation is signed off .*\(d\)/);
    // The texts people read carry no HTTP status code (the problem type is shown beside them).
    for (const type of [
      PROBLEM_TYPES.orderStale,
      PROBLEM_TYPES.orderState,
      PROBLEM_TYPES.signOffMissing,
      PROBLEM_TYPES.qualityHold,
      PROBLEM_TYPES.genealogyPending,
      PROBLEM_TYPES.commandsUnsettled,
    ]) {
      expect(orderFailure(conflict(type)).text, type).not.toMatch(/409/);
    }
    const forbidden = new ApiError('Forbidden', 403, {
      type: PROBLEM_TYPES.forbidden,
      title: 'Forbidden',
      status: 403,
      detail: 'order:release',
      instance: '/x',
    });
    expect(orderFailure(forbidden)).toMatchObject({
      kind: 'refused',
      type: PROBLEM_TYPES.forbidden,
    });
    expect(orderFailure(new ApiError('down', 0)).type).toBeUndefined();
  });

  it('writes flags and counts for people', () => {
    expect(
      flagTexts(order('A', { flags: { short: true, dispatchFailed: true, dispatchLost: true } })),
    ).toEqual(['Short', 'Dispatch failed', 'Dispatch lost']);
    expect(countsText({})).toBe('–');
    expect(countsText({ b: 2, a: 1, z: 0 })).toBe('a: 1, b: 2');
  });

  it('marks an unfinished order past its due date overdue, never a finished one (P-02)', () => {
    const due = Date.parse('2026-10-15T19:00:00.000Z');
    const late = order('A', { dueDate: '2026-10-15T19:00:00.000Z' });
    expect(isOverdue(late, due + 1)).toBe(true);
    // At the due instant itself: not yet.
    expect(isOverdue(late, due)).toBe(false);
    expect(isOverdue(late, undefined)).toBe(false);
    for (const status of ['imported', 'released', 'dispatched', 'in-progress'] as const) {
      expect(isOverdue({ ...late, status }, due + 1)).toBe(true);
    }
    for (const status of ['completed', 'closed', 'cancelled', 'rejected'] as const) {
      expect(isOverdue({ ...late, status }, due + 1)).toBe(false);
    }
  });

  it('writes codes as words, ERP statuses as tones and priorities as glyphs', () => {
    expect(orderCodeWords('revision-refused')).toBe('Revision refused');
    expect(orderCodeWords('  command_failed ')).toBe('Command failed');
    expect(orderCodeWords('SENT')).toBe('Sent');
    expect(
      ['rejected', 'refused', 'conflict', 'revision-refused', 'pending', 'sent', 'imported'].map(
        erpStatusTone,
      ),
    ).toEqual(['alarm', 'alarm', 'warn', 'warn', 'info', 'neutral', 'neutral']);
    expect([1, 2, 3, 5].map(priorityGlyph)).toEqual([
      'triangles-up',
      'triangle-up',
      undefined,
      undefined,
    ]);
  });
});
