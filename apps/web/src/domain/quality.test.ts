import { PROBLEM_TYPES } from '@shopfloor/contracts/mes-api';
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { ApiError } from '../api/client.ts';
import type { LiveQuality } from '../live/live-quality.ts';
import {
  HOLD_ID,
  HOLD_ID_2,
  REASONS,
  characteristic,
  chart,
  hold,
  point,
  signal,
} from '../test/quality-fixtures.ts';
import {
  canAcknowledgeSignal,
  canSuggestHold,
  commentProblem,
  finalityText,
  fromPlantInput,
  holdIdsIn,
  holdMatches,
  isOpenEpisode,
  isStale,
  limitsDraftProblems,
  mergeHolds,
  mergeSignals,
  newestCharacteristic,
  newestHold,
  pointsInWindow,
  qualityFailure,
  reasonsFor,
  rulesText,
  subjectFromSearch,
  subjectHref,
  subjectText,
  suggestedWindow,
  toPlantInput,
} from './quality.ts';

const live = (overrides: Partial<LiveQuality> = {}): LiveQuality => ({
  signals: {},
  holds: {},
  characteristics: {},
  seq: 1,
  ...overrides,
});

const problemError = (type: string, detail = 'detail') =>
  new ApiError('x', 409, { type, title: 'Conflict', status: 409, detail, instance: '/x' });

describe('quality rules (#203)', () => {
  it('names and links subjects', () => {
    expect(subjectText({ kind: 'lot', id: 'K1' })).toBe('Lot K1');
    expect(subjectHref({ kind: 'order', id: 'PO 1' })).toBe('/orders/PO%201');
    expect(subjectHref({ kind: 'lot', id: 'K1' })).toBe('/trace/lots/K1');
    expect(subjectHref({ kind: 'serial', id: 'S1' })).toBe('/trace/serials/S1');
    expect(subjectHref({ kind: 'carton', id: 'C1' })).toBe('/trace/cartons/C1');
    expect(subjectFromSearch('lot', 'K1')).toEqual({ kind: 'lot', id: 'K1' });
    expect(subjectFromSearch('lot', 'K 1')).toBeUndefined();
    expect(subjectFromSearch('pallet', 'K1')).toBeUndefined();
    expect(subjectFromSearch(undefined, undefined)).toBeUndefined();
    expect(rulesText([])).toBe('none');
    expect(rulesText([1, 2, 5])).toBe('1, 2, 5');
  });

  it('tells an episode’s state, finality and what may be done with it', () => {
    const open = signal(1);
    const closed = signal(2, { closedBy: open.last, status: 'final', extentFinal: true });
    const withdrawn = signal(3, { status: 'withdrawn' });
    expect([isOpenEpisode(open), isOpenEpisode(closed), isOpenEpisode(withdrawn)]).toEqual([
      true,
      false,
      false,
    ]);
    expect(canAcknowledgeSignal(open)).toBe(true);
    expect(canAcknowledgeSignal(withdrawn)).toBe(false);
    expect(
      canAcknowledgeSignal(
        signal(4, { acknowledged: { by: 'q', at: open.detectedAt, plantAt: null, comment: 'c' } }),
      ),
    ).toBe(false);
    expect(canSuggestHold(withdrawn)).toBe(false);
    expect(finalityText(open)).toMatch(/^Provisional/);
    expect(finalityText(closed)).toBe('Final, extent final');
    expect(finalityText(signal(5, { status: 'final' }))).toMatch(/extent can still grow/);
    expect(finalityText(withdrawn)).toBe('Withdrawn');
  });

  it('merges pushed episodes by id: newer or equal row version wins, removed ones go', () => {
    const rest = [signal(1), signal(2)];
    const merged = mergeSignals(
      'leak-rate',
      rest,
      live({
        signals: {
          '1': { signal: signal(1, { rowVersion: 2, status: 'final' }), removed: false },
          '2': { signal: signal(2), removed: true },
          '3': { signal: signal(3), removed: false },
          '9': { signal: signal(9, { characteristic: 'torque' }), removed: false },
        },
      }),
    );
    expect(merged.map((s) => [s.id, s.status])).toEqual([
      [3, 'provisional'],
      [1, 'final'],
    ]);
    // An older pushed copy never replaces the read one.
    expect(
      mergeSignals(
        'leak-rate',
        [signal(1, { rowVersion: 3 })],
        live({ signals: { '1': { signal: signal(1, { rowVersion: 2 }), removed: false } } }),
      )[0]?.rowVersion,
    ).toBe(3);
    expect(mergeSignals('leak-rate', rest, undefined).map((s) => s.id)).toEqual([2, 1]);
  });

  it('merges pushed holds and characteristics', () => {
    const read = hold();
    const scope = hold({ scope: { units: 9, cartons: 1, orders: 1 } });
    expect(newestHold(read, live({ holds: { [HOLD_ID]: scope } })).scope.units).toBe(9);
    expect(newestHold(hold({ version: 2 }), live({ holds: { [HOLD_ID]: read } })).version).toBe(2);
    expect(newestHold(read, undefined)).toBe(read);
    const other = hold({ id: HOLD_ID_2, state: 'released', subject: { kind: 'order', id: 'O' } });
    const filter = { states: ['open' as const] };
    expect(mergeHolds([read], live({ holds: { [HOLD_ID_2]: other } }), filter)).toEqual([read]);
    expect(
      mergeHolds([read], live({ holds: { [HOLD_ID_2]: other } }), { states: [] }).map((h) => h.id),
    ).toEqual([HOLD_ID, HOLD_ID_2].sort());
    // A read hold that a push moved out of the filter leaves the list.
    expect(
      mergeHolds(
        [read],
        live({ holds: { [HOLD_ID]: hold({ state: 'released', version: 2 }) } }),
        filter,
      ),
    ).toEqual([]);
    expect(holdMatches(read, { states: [], subject: { kind: 'lot', id: 'K1' } })).toBe(true);
    expect(holdMatches(read, { states: [], subject: { kind: 'lot', id: 'K2' } })).toBe(false);
    const c = characteristic();
    expect(
      newestCharacteristic(
        c,
        live({ characteristics: { 'leak-rate': characteristic({ version: 3 }) } }),
      ).version,
    ).toBe(3);
    expect(
      newestCharacteristic(
        c,
        live({ characteristics: { 'leak-rate': characteristic({ version: 1 }) } }),
      ).version,
    ).toBe(2);
  });

  it('lists reasons for a transition and finds hold ids in a problem', () => {
    expect(reasonsFor(REASONS.reasons, 'release').map((r) => r.id)).toEqual(['CONFORMS']);
    expect(holdIdsIn(`holds: ${HOLD_ID.toUpperCase()}, ${HOLD_ID_2}, ${HOLD_ID}`)).toEqual([
      HOLD_ID,
      HOLD_ID_2,
    ]);
    expect(holdIdsIn('none')).toEqual([]);
  });

  it('tells the quality module’s refusals apart', () => {
    const texts = { not: 'Not done', what: 'this', thing: 'hold' };
    const kinds = [
      PROBLEM_TYPES.limitsStale,
      PROBLEM_TYPES.signalStale,
      PROBLEM_TYPES.holdStale,
      PROBLEM_TYPES.signalAcknowledged,
      PROBLEM_TYPES.holdDecided,
      PROBLEM_TYPES.signalWithdrawn,
      PROBLEM_TYPES.limitsV1Missing,
      PROBLEM_TYPES.limitsEnded,
    ].map((type) => qualityFailure(problemError(type), texts));
    expect(kinds.map((k) => k.kind)).toEqual([
      'stale',
      'stale',
      'stale',
      'decided',
      'decided',
      'withdrawn',
      'state',
      'state',
    ]);
    expect(kinds[0]?.type).toBe(PROBLEM_TYPES.limitsStale);
    expect(qualityFailure(problemError('about:blank'), texts)).toMatchObject({
      kind: 'conflict',
      type: undefined,
    });
    expect(
      qualityFailure(
        new ApiError('x', 403, {
          type: PROBLEM_TYPES.forbidden,
          title: 'Forbidden',
          status: 403,
          detail: 'no',
          instance: '/x',
        }),
        texts,
      ).kind,
    ).toBe('refused');
    expect(qualityFailure(new ZodError([]), texts).kind).toBe('invalid');
  });

  it('checks comments and drafts', () => {
    expect(commentProblem('  ', true)).toBe('A comment is required.');
    expect(commentProblem('', false)).toBeUndefined();
    expect(commentProblem('x'.repeat(501), false)).toMatch(/At most 500/);
    expect(isStale(1, 1)).toBe(false);
    expect(isStale(1, 2)).toBe(true);
    expect(limitsDraftProblems({ from: '', to: 'x', comment: '' })).toEqual([
      'Give the window’s first time.',
      'Give the window’s last time.',
      'A comment is required.',
    ]);
    expect(
      limitsDraftProblems({ from: '2026-10-15T10:00', to: '2026-10-15T09:00', comment: 'c' }),
    ).toEqual(['The window’s first time must not be after its last.']);
    expect(
      limitsDraftProblems({ from: '2026-10-15T08:00', to: '2026-10-15T09:00', comment: 'c' }),
    ).toEqual([]);
  });

  it('reads and writes plant time (Europe/Istanbul, UTC+3) in datetime-local inputs', () => {
    expect(toPlantInput('2026-10-15T05:41:00.000Z')).toBe('2026-10-15T08:41:00');
    expect(fromPlantInput('2026-10-15T08:41')).toBe('2026-10-15T05:41:00.000Z');
    expect(fromPlantInput('2026-10-15T08:41:30')).toBe('2026-10-15T05:41:30.000Z');
    expect(fromPlantInput('2026-10-15')).toBeUndefined();
    expect(fromPlantInput('2026-13-45T08:41')).toBeUndefined();
  });

  it('offers a window of the last baseline-sized final readings', () => {
    const view = chart({
      characteristic: characteristic({ baseline: { needed: 2, final: 2 } }),
      points: {
        I: [point(1, 2), point(2, 2), point(3, 2), point(4, 2, { final: false })],
        MR: [],
        Xbar: [],
        R: [],
      },
    });
    expect(suggestedWindow(view)).toEqual({ from: point(2, 0).at, to: point(3, 0).at });
    expect(suggestedWindow(chart({ points: { I: [], MR: [], Xbar: [], R: [] } }))).toBeUndefined();
    expect(pointsInWindow(view.points.I, point(2, 0).at, point(4, 0).at)).toBe(3);
  });
});
