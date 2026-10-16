import type { ShiftPattern } from '@shopfloor/shift-calendar';
import { describe, expect, it } from 'vitest';
import { hourEnd, hourStart, shiftBuckets, shiftInstance, shiftInstances } from './shifts.ts';

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

describe('shift instances and buckets from the calendar (#120)', () => {
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
});
