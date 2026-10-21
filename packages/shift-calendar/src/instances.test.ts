import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  NO_SHIFT,
  hourEnd,
  hourStart,
  nextShift,
  noShiftKey,
  shiftBuckets,
  shiftInstance,
  shiftInstances,
  shiftKeyAt,
  type ShiftPattern,
} from './index.ts';

const HOUR = 3_600_000;
const PATTERN: ShiftPattern = {
  timeZone: 'Europe/Istanbul',
  workdays: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'],
  shifts: [
    { id: 'A', start: '06:00', end: '14:00', break: { start: '10:00', minutes: 30 } },
    { id: 'B', start: '14:00', end: '22:00', break: { start: '18:00', minutes: 30 } },
    { id: 'C', start: '22:00', end: '06:00', break: { start: '02:00', minutes: 30 } },
  ],
};
const utc = (value: string): number => Date.parse(value);

describe('shift instances and buckets from the calendar (#120, moved here by #144)', () => {
  it('rounds to whole UTC hours', () => {
    expect(hourStart(utc('2026-10-12T03:30:00Z'))).toBe(utc('2026-10-12T03:00:00Z'));
    expect(hourEnd(utc('2026-10-12T03:30:00Z'))).toBe(utc('2026-10-12T04:00:00Z'));
    expect(hourEnd(utc('2026-10-12T03:00:00Z'))).toBe(utc('2026-10-12T03:00:00Z'));
    expect(hourStart(-1)).toBe(-HOUR);
  });

  it('keeps scheduled shifts whole and clips the no-shift stretch to the range', () => {
    // Friday 12:30 to Saturday 05:15 UTC: B (cut by the range), C (whole), then the weekend.
    const buckets = shiftBuckets(PATTERN, utc('2026-10-16T12:30:00Z'), utc('2026-10-17T05:15:00Z'));
    expect(
      buckets.map((b) => [b.key, new Date(b.start).toISOString(), new Date(b.end).toISOString()]),
    ).toEqual([
      ['2026-10-16/B', '2026-10-16T11:00:00.000Z', '2026-10-16T19:00:00.000Z'],
      ['2026-10-16/C', '2026-10-16T19:00:00.000Z', '2026-10-17T03:00:00.000Z'],
      ['no-shift', '2026-10-17T03:00:00.000Z', '2026-10-17T06:00:00.000Z'],
    ]);
  });

  it('lists scheduled shifts with their breaks, and finds one by date and id', () => {
    const shifts = shiftInstances(
      PATTERN,
      utc('2026-10-16T20:00:00Z'),
      utc('2026-10-19T04:00:00Z'),
    );
    expect(shifts.map((s) => s.key)).toEqual(['2026-10-16/C', '2026-10-19/A']);
    // The night shift's break is after midnight, Istanbul time.
    expect(shifts[0]?.breaks).toEqual([
      { start: utc('2026-10-16T23:00:00Z'), end: utc('2026-10-16T23:30:00Z') },
    ]);
    expect(shiftInstance(PATTERN, '2026-10-16', 'C')).toEqual(shifts[0]);
    expect(shiftInstance(PATTERN, '2026-10-17', 'A')).toBeUndefined();
    expect(shiftInstance(PATTERN, '2026-10-12', 'Z')).toBeUndefined();
    expect(shiftInstance(PATTERN, 'not-a-date', 'A')).toBeUndefined();
    expect(
      shiftInstances(PATTERN, utc('2026-10-17T06:00:00Z'), utc('2026-10-18T06:00:00Z')),
    ).toEqual([]);
  });

  it('finds the next shift, over the weekend too', () => {
    const friday = shiftInstance(PATTERN, '2026-10-16', 'C');
    expect(friday && nextShift(PATTERN, friday)?.key).toBe('2026-10-19/A');
    const monday = shiftInstance(PATTERN, '2026-10-12', 'A');
    expect(monday && nextShift(PATTERN, monday)?.key).toBe('2026-10-12/B');
    expect(nextShift({ ...PATTERN, workdays: [] }, { end: utc('2026-10-12T03:00:00Z') })).toBe(
      undefined,
    );
  });

  it('keys a no-shift stretch by the shift end that starts it (ADR-0024)', () => {
    // The weekend after Friday's night shift (ends Saturday 06:00 Istanbul, 03:00Z).
    expect(noShiftKey(PATTERN, utc('2026-10-17T03:00:00Z'))).toBe(
      'no-shift/2026-10-17T03:00:00.000Z',
    );
    expect(noShiftKey(PATTERN, utc('2026-10-18T10:00:00Z'))).toBe(
      'no-shift/2026-10-17T03:00:00.000Z',
    );
    // No shift ended in the 7 days before: the stretch's own start.
    expect(noShiftKey({ ...PATTERN, workdays: [] }, utc('2026-10-18T10:00:00Z'))).toBe(
      'no-shift/2026-10-18T10:00:00.000Z',
    );
  });

  // 15 s, not Vitest's default 5 s (#288): 200 runs over ranges of up to 5 days, every hour
  // checked, take 0.7 to 0.8 s alone with coverage and took 2.4 to 2.6 s in `pnpm verify` at
  // turbo's default concurrency, half the default. 15 s is about six times that worst; runs and
  // sizes are unchanged.
  it(
    'property: buckets tile the range in whole hours, keyed as shiftKeyAt keys their hours',
    {
      timeout: 15_000,
    },
    () => {
      const monday = utc('2026-10-12T00:00:00Z');
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 21 * 24 * HOUR }),
          fc.integer({ min: 1, max: 5 * 24 * HOUR }),
          (offset, length) => {
            const from = monday + offset;
            const to = from + length;
            const buckets = shiftBuckets(PATTERN, from, to);
            expect(buckets.length).toBeGreaterThan(0);
            for (const [i, bucket] of buckets.entries()) {
              expect(hourStart(bucket.start)).toBe(bucket.start);
              expect(hourStart(bucket.end)).toBe(bucket.end);
              expect(bucket.end).toBeGreaterThan(bucket.start);
              const next = buckets[i + 1];
              if (next) expect(next.start).toBe(bucket.end);
              for (let hour = bucket.start; hour < bucket.end; hour += HOUR) {
                expect(shiftKeyAt(PATTERN, hour)).toBe(bucket.key);
              }
            }
            expect(buckets[0]?.start).toBeLessThanOrEqual(from);
            expect(buckets.at(-1)?.end).toBeGreaterThanOrEqual(to);
            // The scheduled shifts are exactly the buckets that are not no-shift.
            expect(shiftInstances(PATTERN, from, to).map((s) => [s.key, s.start, s.end])).toEqual(
              buckets.filter((b) => b.key !== NO_SHIFT).map((b) => [b.key, b.start, b.end]),
            );
          },
        ),
        { numRuns: 200 },
      );
    },
  );
});
