import { describe, expect, it } from 'vitest';
import { shiftAt, shiftBoundaries, type ShiftPattern } from './index.ts';

const istanbul = {
  timeZone: 'Europe/Istanbul',
  workdays: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'] as const,
  shifts: [
    { id: 'A', start: '06:00', end: '14:00', break: { start: '10:00', minutes: 30 } },
    { id: 'B', start: '14:00', end: '22:00', break: { start: '18:00', minutes: 30 } },
    { id: 'C', start: '22:00', end: '06:00', break: { start: '02:00', minutes: 30 } },
  ],
};
const config: ShiftPattern = { ...istanbul, workdays: [...istanbul.workdays] };

const local = (iso: string, zone = 'Europe/Istanbul'): number =>
  Temporal.PlainDateTime.from(iso).toZonedDateTime(zone).epochMilliseconds;

const describeBoundaries = (from: string, to: string, shifts = config, zone = 'Europe/Istanbul') =>
  shiftBoundaries(shifts, local(from, zone), local(to, zone)).map(
    (b) =>
      `${Temporal.Instant.fromEpochMilliseconds(b.at).toZonedDateTimeISO(zone).toPlainDateTime().toString().slice(0, 16)} ${b.action} ${b.shiftId}@${b.shiftDate}`,
  );

describe('shift calendar (plan section 3, rev. 2 week boundaries)', () => {
  it('runs A, B and C back to back with handovers instead of shift ends', () => {
    expect(describeBoundaries('2026-10-13T05:00', '2026-10-14T07:00')).toEqual([
      '2026-10-13T06:00 shift-start A@2026-10-13',
      '2026-10-13T10:00 break-start A@2026-10-13',
      '2026-10-13T10:30 break-end A@2026-10-13',
      '2026-10-13T14:00 shift-start B@2026-10-13',
      '2026-10-13T18:00 break-start B@2026-10-13',
      '2026-10-13T18:30 break-end B@2026-10-13',
      '2026-10-13T22:00 shift-start C@2026-10-13',
      '2026-10-14T02:00 break-start C@2026-10-13',
      '2026-10-14T02:30 break-end C@2026-10-13',
      '2026-10-14T06:00 shift-start A@2026-10-14',
    ]);
  });

  it('ends the week with the Friday night shift at Saturday 06:00 and has no Sunday night shift', () => {
    const lines = describeBoundaries('2026-10-16T21:00', '2026-10-19T07:00');
    expect(lines).toEqual([
      '2026-10-16T22:00 shift-start C@2026-10-16',
      '2026-10-17T02:00 break-start C@2026-10-16',
      '2026-10-17T02:30 break-end C@2026-10-16',
      '2026-10-17T06:00 shift-end C@2026-10-16',
      '2026-10-19T06:00 shift-start A@2026-10-19',
    ]);
  });

  it('reports the shift and break at an instant, belonging to the date it started', () => {
    expect(shiftAt(config, local('2026-10-14T03:00'))).toEqual({
      shiftId: 'C',
      shiftDate: '2026-10-13',
      inBreak: false,
    });
    expect(shiftAt(config, local('2026-10-14T02:10'))?.inBreak).toBe(true);
    expect(shiftAt(config, local('2026-10-12T06:00'))?.shiftId).toBe('A');
    expect(shiftAt(config, local('2026-10-18T12:00'))).toBeUndefined();
    expect(shiftAt(config, local('2026-10-12T05:59'))).toBeUndefined();
  });

  it('keeps wall-clock shift times across a daylight-saving change', () => {
    const berlin = { ...config, timeZone: 'Europe/Berlin' };
    const lines = describeBoundaries(
      '2026-10-24T21:00',
      '2026-10-26T07:00',
      {
        ...berlin,
        workdays: ['SATURDAY', 'MONDAY'],
      },
      'Europe/Berlin',
    );
    expect(lines).toContain('2026-10-25T06:00 shift-end C@2026-10-24');
    const start = local('2026-10-24T22:00', 'Europe/Berlin');
    const end = local('2026-10-25T06:00', 'Europe/Berlin');
    expect((end - start) / 3_600_000).toBe(9);
  });
});
