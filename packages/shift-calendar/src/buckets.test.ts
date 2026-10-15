import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { NO_SHIFT, shiftAt, shiftCuts, shiftKeyAt, type ShiftPattern } from './index.ts';

const pattern: ShiftPattern = {
  timeZone: 'Europe/Istanbul',
  workdays: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'],
  shifts: [
    { id: 'A', start: '06:00', end: '14:00', break: { start: '10:00', minutes: 30 } },
    { id: 'B', start: '14:00', end: '22:00', break: { start: '18:00', minutes: 30 } },
    { id: 'C', start: '22:00', end: '06:00' },
  ],
};

const local = (iso: string): number =>
  Temporal.PlainDateTime.from(iso).toZonedDateTime('Europe/Istanbul').epochMilliseconds;

const MONDAY = local('2026-10-12T00:00');
const WEEK = 7 * 24 * 3_600_000;

describe('shift buckets, as the ground truth keys them', () => {
  it.each([
    ['2026-10-12T05:59:59.999', NO_SHIFT], // Monday before the first shift
    ['2026-10-12T06:00', '2026-10-12/A'],
    ['2026-10-12T10:15', '2026-10-12/A'], // the break belongs to its shift
    ['2026-10-12T14:00', '2026-10-12/B'], // handover: B starts where A ends
    ['2026-10-12T23:00', '2026-10-12/C'],
    ['2026-10-13T05:59', '2026-10-12/C'], // the night shift carries its start date
    ['2026-10-16T22:00', '2026-10-16/C'], // Friday night shift
    ['2026-10-17T05:59', '2026-10-16/C'], // … ends on Saturday morning
    ['2026-10-17T06:00', NO_SHIFT], // weekend
    ['2026-10-18T23:00', NO_SHIFT],
  ])('puts %s into %s', (time, key) => {
    expect(shiftKeyAt(pattern, local(time))).toBe(key);
  });

  it('cuts only where the bucket changes: shift starts and ends, never at breaks or twice at a handover', () => {
    const cuts = shiftCuts(pattern, local('2026-10-12T00:00'), local('2026-10-13T00:00'));
    expect(cuts).toEqual([
      local('2026-10-12T06:00'),
      local('2026-10-12T14:00'),
      local('2026-10-12T22:00'),
    ]);
    const weekend = shiftCuts(pattern, local('2026-10-16T12:00'), local('2026-10-19T12:00'));
    expect(weekend).toEqual([
      local('2026-10-16T14:00'),
      local('2026-10-16T22:00'),
      local('2026-10-17T06:00'), // Friday's night shift ends; the weekend begins
      local('2026-10-19T06:00'),
    ]);
  });

  it('property: the bucket is constant between consecutive cuts, and changes at every cut', () => {
    const cuts = shiftCuts(pattern, MONDAY, MONDAY + WEEK);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: WEEK - 2 }), (offset) => {
        const time = MONDAY + offset;
        const previousCut = [...cuts].reverse().find((c) => c <= time) ?? MONDAY;
        expect(shiftKeyAt(pattern, time)).toBe(shiftKeyAt(pattern, previousCut));
      }),
    );
    for (const cut of cuts) {
      expect(shiftKeyAt(pattern, cut - 1), String(new Date(cut))).not.toBe(
        shiftKeyAt(pattern, cut),
      );
    }
  });

  it('reports breaks inside a shift', () => {
    expect(shiftAt(pattern, local('2026-10-12T10:15'))).toEqual({
      shiftId: 'A',
      shiftDate: '2026-10-12',
      inBreak: true,
    });
    expect(shiftAt(pattern, local('2026-10-12T10:30'))?.inBreak).toBe(false);
  });

  it('skips days that are not workdays, whatever the weekday order in the pattern', () => {
    const weekendOnly: ShiftPattern = { ...pattern, workdays: ['SUNDAY', 'SATURDAY'] };
    expect(shiftKeyAt(weekendOnly, local('2026-10-12T08:00'))).toBe(NO_SHIFT);
    expect(shiftKeyAt(weekendOnly, local('2026-10-17T08:00'))).toBe('2026-10-17/A');
  });
});
