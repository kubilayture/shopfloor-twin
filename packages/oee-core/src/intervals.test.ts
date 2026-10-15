import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  HOUR,
  hourCuts,
  intervalsFromFacts,
  splitAt,
  totalsByState,
  type StateInterval,
} from './intervals.ts';

const T0 = Date.UTC(2026, 9, 12, 3);

describe('intervals from facts', () => {
  it('lets each state last until the next fact, and the last until the end', () => {
    const facts = [
      { at: T0, state: 'Idle', cause: null },
      { at: T0 + 1_000, state: 'Running', cause: null },
      { at: T0 + 1_000, state: 'Stopped', cause: 'JAM' }, // same millisecond: zero length, dropped
      { at: T0 + 5_000, state: 'Running', cause: null },
    ];
    expect(intervalsFromFacts(facts, T0 + 9_000)).toEqual([
      { from: T0, to: T0 + 1_000, state: 'Idle', cause: null },
      { from: T0 + 1_000, to: T0 + 5_000, state: 'Stopped', cause: 'JAM' },
      { from: T0 + 5_000, to: T0 + 9_000, state: 'Running', cause: null },
    ]);
    expect(intervalsFromFacts([], T0)).toEqual([]);
  });

  it('refuses facts that go back in time', () => {
    expect(() =>
      intervalsFromFacts(
        [
          { at: T0 + 5, state: 'Idle', cause: null },
          { at: T0, state: 'Running', cause: null },
        ],
        T0 + 10,
      ),
    ).toThrow(/back in time/);
  });
});

describe('splitting at boundaries', () => {
  const interval: StateInterval = {
    from: T0 - 1_000,
    to: T0 + 2 * HOUR + 500,
    state: 'Running',
    cause: null,
  };

  it('cuts at UTC hours and at given boundaries, keeping state and cause', () => {
    const cuts = [...hourCuts(interval.from, interval.to), T0 + 90 * 60_000];
    expect(splitAt(interval, cuts).map((p) => [p.from - T0, p.to - T0])).toEqual([
      [-1_000, 0],
      [0, HOUR],
      [HOUR, 90 * 60_000],
      [90 * 60_000, HOUR * 2],
      [HOUR * 2, HOUR * 2 + 500],
    ]);
  });

  it('ignores cuts at the edges, outside the interval or repeated', () => {
    expect(splitAt(interval, [interval.from, interval.to, T0 - HOUR, T0, T0])).toHaveLength(2);
    expect(hourCuts(T0, T0 + HOUR)).toEqual([]); // both ends are hours: nothing strictly inside
    expect(hourCuts(-HOUR - 1, 1)).toEqual([-HOUR, 0]); // before 1970 too, in integers only
  });

  it('property: pieces are contiguous, sum to the original, and never contain a cut', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10 * HOUR }),
        fc.integer({ min: 1, max: 30 * HOUR }),
        fc.array(fc.integer({ min: -HOUR, max: 40 * HOUR }), { maxLength: 30 }),
        (start, length, offsets) => {
          const whole: StateInterval = {
            from: T0 + start,
            to: T0 + start + length,
            state: 'Down',
            cause: 'X',
          };
          const cuts = [...offsets.map((o) => T0 + o), ...hourCuts(whole.from, whole.to)];
          const pieces = splitAt(whole, cuts);
          expect(pieces[0]?.from).toBe(whole.from);
          expect(pieces.at(-1)?.to).toBe(whole.to);
          for (const [i, piece] of pieces.entries()) {
            expect(piece.to).toBeGreaterThan(piece.from);
            if (i > 0) expect(piece.from).toBe(pieces[i - 1]?.to);
            expect(cuts.some((c) => c > piece.from && c < piece.to)).toBe(false);
            expect(Math.floor(piece.from / HOUR)).toBe(Math.floor((piece.to - 1) / HOUR)); // one hour each
          }
          expect(totalsByState(pieces).get('Down')).toBe(length);
        },
      ),
    );
  });
});
