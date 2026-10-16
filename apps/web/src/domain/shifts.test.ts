import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client.ts';
import { kpiBucket } from '../test/alarm-fixtures.ts';
import { EPOCH } from '../test/fixtures.ts';
import { SHIFT_KEY, bucket, result } from '../test/oee-fixtures.ts';
import { auditEntry, note, report, shiftRecord } from '../test/shift-fixtures.ts';
import {
  changesAfterFinal,
  draftOf,
  isNewerShift,
  isStaleDraft,
  liveAlarmKpi,
  liveOee,
  mergeNotes,
  noteFailure,
  production,
} from './shifts.ts';

const problem = (status: number, detail: string) =>
  new ApiError(`x: ${detail}`, status, {
    type: 'about:blank',
    title: 'x',
    status,
    detail,
    instance: '/x',
  });

describe('shift instances', () => {
  it('orders instances as the MES pushes them: every part at least as high, one higher', () => {
    const base = shiftRecord({ status: 'ended', revision: { inputs: 1, content: 2 } });
    expect(isNewerShift({ ...base, status: 'final' }, base)).toBe(true);
    expect(isNewerShift({ ...base, revision: { inputs: 1, content: 3 } }, base)).toBe(true);
    expect(isNewerShift(base, base)).toBe(false);
    expect(isNewerShift({ ...base, status: 'running' }, base)).toBe(false);
    // Higher in one counter, lower in another: never replaces the known copy.
    expect(
      isNewerShift({ ...base, status: 'final', revision: { inputs: 0, content: 5 } }, base),
    ).toBe(false);
  });

  it('counts the changes after final: inputs, and content less the note writes before', () => {
    expect(changesAfterFinal(report())).toBeUndefined();
    const before = note(1, { updatedAt: '2026-10-16T08:00:00.000Z' });
    const after = note(1, { version: 2, updatedAt: '2026-10-16T10:00:00.000Z' });
    const final = report({
      status: 'final',
      final: true,
      finalAt: '2026-10-16T09:00:00.000Z',
      revision: { inputs: 2, content: 3 },
      notes: [{ note: after, history: [auditEntry(after), auditEntry(before)] }],
    });
    // Content 3: one note write before final, so two after (the edit and, e.g., a recode).
    expect(changesAfterFinal(final)).toEqual({ inputs: 2, content: 2 });
    expect(changesAfterFinal({ ...final, revision: { inputs: 0, content: 1 } })).toEqual({
      inputs: 0,
      content: 0,
    });
  });
});

describe('live numbers', () => {
  const ref = { key: SHIFT_KEY, epoch: EPOCH };

  it('shows a pushed OEE bucket of this shift and epoch unless the report is further along', () => {
    const rest = bucket('cnc-01');
    const pushed = bucket('cnc-01', { provisionalMs: 1 });
    expect(liveOee(rest, pushed, ref)).toEqual({ bucket: pushed, live: true });
    expect(liveOee(rest, undefined, ref)).toEqual({ bucket: rest, live: false });
    expect(liveOee(rest, bucket('cnc-01', { key: '2026-10-15/B' }), ref).live).toBe(false);
    const older = bucket('cnc-01', { members: [{ equipment: 'cnc-01', epoch: EPOCH - 1 }] });
    expect(liveOee(rest, older, ref).live).toBe(false);
    const final = bucket('cnc-01', { final: true });
    expect(liveOee(final, pushed, ref)).toEqual({ bucket: final, live: false });
    // A machine the report had no data for yet.
    expect(liveOee(undefined, pushed, ref)).toEqual({ bucket: pushed, live: true });
  });

  it('shows a pushed alarm KPI bucket of this shift and epoch', () => {
    const rest = kpiBucket();
    const pushed = kpiBucket({ raises: 15 });
    expect(liveAlarmKpi(rest, pushed, ref)).toEqual({ bucket: pushed, live: true });
    expect(liveAlarmKpi(null, null, ref)).toEqual({ bucket: undefined, live: false });
    expect(liveAlarmKpi(rest, kpiBucket({ epoch: EPOCH + 1 }), ref).live).toBe(false);
    expect(liveAlarmKpi(rest, kpiBucket({ bucket: 'hour' }), ref).live).toBe(false);
  });

  it('takes live production from the pushed totals and the rest from the report', () => {
    const shown = report();
    const live = bucket('cnc-01', {
      result: result({
        totals: { ...result().totals, produced: 12, good: 10, scrap: 2, rework: 0 },
      }),
    });
    const rows = production(shown, ['cnc-01', 'wsh-01', 'asm-01', 'xyz-01'], (id) =>
      id === 'cnc-01' ? { bucket: live, live: true } : { bucket: undefined, live: false },
    );
    expect(rows.machines.map((row) => [row.equipment, row.produced, row.scrap, row.live])).toEqual([
      ['cnc-01', 12, 2, true],
      ['wsh-01', 10, 1, false],
      ['asm-01', 10, 1, false],
    ]);
    expect(rows.scrap).toBe(4);
    expect(rows.finished).toEqual({ equipment: 'asm-01', good: 9 });
    const still = production(shown, ['cnc-01'], () => ({ bucket: undefined, live: false }));
    expect(still.scrap).toBe(3);
    expect(still.live).toBe(false);
    const none = production(
      { production: { ...shown.production, finished: { equipment: null, good: 0 } } },
      [],
      () => ({ bucket: undefined, live: false }),
    );
    expect(none.finished.good).toBeNull();
  });
});

describe('handover notes', () => {
  it('merges notes from every source by the highest version, by creation', () => {
    const one = note(1);
    const two = note(2);
    const merged = mergeNotes(
      [
        { note: { ...one, version: 2, text: 'v2' }, history: [] },
        { note: one, history: [] },
      ],
      {
        '2': { ...two, version: 3 },
        '3': note(3, { shiftKey: '2026-10-15/B' }),
        '4': note(4, { epoch: EPOCH + 1 }),
      },
      EPOCH,
      SHIFT_KEY,
    );
    expect(merged.map((item) => [item.id, item.version])).toEqual([
      [1, 2],
      [2, 3],
    ]);
  });

  it('keeps the version a draft started from: a newer note makes it stale', () => {
    const draft = draftOf(note(1, { version: 2 }));
    expect(isStaleDraft(draft, note(1, { version: 2 }))).toBe(false);
    expect(isStaleDraft(draft, note(1, { version: 3 }))).toBe(true);
  });

  it('tells a stale version, a closed handover and the note limit apart', () => {
    expect(noteFailure(problem(409, 'note 1 changed: version is 3, not 2')).kind).toBe('stale');
    const closed = noteFailure(
      problem(
        409,
        'handover closed: notes of 2026-10-15/A can be written until 2026-10-15T19:00:00.000Z (plant time)',
      ),
    );
    expect(closed.kind).toBe('closed');
    expect(closed.text).toContain('handover window is closed');
    expect(
      noteFailure(problem(409, 'handover not open: shift 2026-10-15/A has not begun')).kind,
    ).toBe('closed');
    const limit = noteFailure(problem(422, 'at most 200 notes per shift'));
    expect(limit.kind).toBe('limit');
    expect(limit.text).toContain('200 notes');
    expect(noteFailure(problem(403, 'origin')).kind).toBe('refused');
    expect(noteFailure(problem(422, 'something else')).kind).toBe('invalid');
    expect(noteFailure(new ApiError('down', 0)).kind).toBe('unavailable');
  });
});
