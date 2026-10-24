import { describe, expect, it } from 'vitest';
import {
  formatClockSeconds,
  formatClockTime,
  durationText,
  formatDuration,
  formatPlantTime,
  formatPlantTimeMinutes,
  formatPlantTimeRelative,
  isoDuration,
  isRangeKey,
  parseIsoInstant,
  parsePlantClock,
  parsePlantDate,
  plantClockText,
  plantDateText,
  plantDayLabel,
  plantDayOf,
  plantDaysBetween,
  plantInstant,
  plantOffsetMs,
  plantTimeText,
  utcInstantText,
  wallTimeText,
} from './time.ts';

describe('time formatting', () => {
  it('shows plant time in Istanbul', () => {
    expect(formatClockTime('2026-10-15T06:00:00.000Z')).toBe('09:00');
    expect(formatPlantTime('2026-10-15T06:00:05.000Z')).toContain('09:00:05');
  });

  it('writes an API time in plant time, never raw UTC (#295)', () => {
    expect(plantTimeText('2026-10-12T03:17:07.000Z')).toBe('Mon 12 Oct, 06:17:07');
    expect(plantTimeText('2026-10-12T03:17:07Z')).toBe(formatPlantTime('2026-10-12T03:17:07Z'));
    expect(plantTimeText(undefined)).toBe('–');
    // Not a time (a malformed event line): as it came, never a thrown RangeError.
    expect(plantTimeText('soon')).toBe('soon');
  });

  it('labels a wall-clock time so it is never read as plant time (#295)', () => {
    expect(wallTimeText('2026-10-22T07:12:03.000Z')).toBe('Thu 22 Oct, 10:12:03 (wall time)');
    expect(wallTimeText('soon')).toBe('soon (wall time)');
  });

  describe('an event time relative to the plant clock (A-01)', () => {
    const clock = '2026-10-15T06:10:00.000Z'; // Thu 15 Oct, 09:10 plant time

    it("shows the time only on the plant clock's current day", () => {
      expect(formatPlantTimeRelative('2026-10-15T04:15:00.000Z', clock)).toBe('07:15:00');
      expect(
        formatPlantTimeRelative(Date.parse('2026-10-15T04:15:00.000Z'), Date.parse(clock)),
      ).toBe('07:15:00');
    });

    it('shows the date for another plant day, past or future', () => {
      // SPINDLE-OVERLOAD raised Mon 12 Oct and still standing on Thu 15 Oct.
      expect(formatPlantTimeRelative('2026-10-12T04:15:00.000Z', clock)).toBe(
        'Mon 12 Oct, 07:15:00',
      );
      expect(formatPlantTimeRelative('2026-10-16T04:15:00.000Z', clock)).toBe(
        'Fri 16 Oct, 07:15:00',
      );
      // The same clock time a week earlier is another day.
      expect(formatPlantTimeRelative('2026-10-08T06:10:00.000Z', clock)).toBe(
        'Thu 08 Oct, 09:10:00',
      );
    });

    it('turns the day at midnight in the plant zone, not in UTC', () => {
      // 21:00 UTC is 00:00 the next day in Istanbul.
      expect(formatPlantTimeRelative('2026-10-14T21:00:00.000Z', clock)).toBe('00:00:00');
      expect(formatPlantTimeRelative('2026-10-14T20:59:59.000Z', clock)).toBe(
        'Wed 14 Oct, 23:59:59',
      );
      // The plant clock just after midnight: still the 14th in UTC, already the 15th in the plant.
      const justAfter = '2026-10-14T21:00:01.000Z';
      expect(formatPlantTimeRelative('2026-10-14T21:00:00.000Z', justAfter)).toBe('00:00:00');
      expect(formatPlantTimeRelative('2026-10-14T20:00:00.000Z', justAfter)).toBe(
        'Wed 14 Oct, 23:00:00',
      );
    });

    it('shows the date while there is no plant clock yet', () => {
      expect(formatPlantTimeRelative('2026-10-15T04:15:00.000Z', undefined)).toBe(
        'Thu 15 Oct, 07:15:00',
      );
    });
  });

  it('keeps the plant zone at UTC+3 all year: no DST shift in the day boundary', () => {
    // Istanbul has had no DST since 2016: midnight is 21:00 UTC in winter and summer alike,
    // The EU switches at 01:00 UTC on 29 March and 25 October 2026: the 28th and 24th are the
    // evenings before a switch, the 29th and 25th the evenings after it.
    const days: readonly (readonly [string, string])[] = [
      ['2026-01-14', '2026-01-15'],
      ['2026-03-28', '2026-03-29'],
      ['2026-03-29', '2026-03-30'],
      ['2026-07-14', '2026-07-15'],
      ['2026-10-24', '2026-10-25'],
      ['2026-10-25', '2026-10-26'],
      ['2026-12-30', '2026-12-31'],
    ];
    for (const [date, next] of days) {
      const before = Date.parse(`${date}T20:59:59.000Z`);
      const after = Date.parse(`${date}T21:00:00.000Z`);
      expect(plantDayOf(before)).toBe(date);
      expect(plantDayOf(after)).toBe(next);
      expect(formatClockSeconds(after)).toBe('00:00:00');
    }
  });

  it('formats durations for people', () => {
    expect(formatDuration(-5)).toBe('0 s');
    expect(formatDuration(12_400)).toBe('12 s');
    expect(formatDuration(245_000)).toBe('4 min 05 s');
    expect(formatDuration(7_500_000)).toBe('2 h 05 min');
    expect(formatDuration(100 * 3_600_000)).toBe('4 d 4 h');
  });

  it('knows its ranges', () => {
    expect(isRangeKey('8h')).toBe(true);
    expect(isRangeKey('toString')).toBe(false);
    expect(isRangeKey(8)).toBe(false);
  });
});

describe('durations and planning times (UX-1c, design system 6.1 and 6.2)', () => {
  it('writes a duration by one rule, seconds under an hour only when asked', () => {
    expect(durationText(45_400)).toBe('45 s');
    expect(durationText(59_999)).toBe('59 s');
    expect(durationText(60_000)).toBe('1 min');
    expect(durationText(725_000)).toBe('12 min');
    expect(durationText(725_000, { seconds: true })).toBe('12 min 05 s');
    expect(durationText(3_599_999, { seconds: true })).toBe('59 min 59 s');
    expect(durationText(3_600_000)).toBe('1 h 00 min');
    expect(durationText((4 * 60 + 54) * 60_000 + 30_000)).toBe('4 h 54 min');
    expect(durationText((4 * 60 + 54) * 60_000 + 30_000, { seconds: true })).toBe('4 h 54 min');
    expect(durationText(86_400_000)).toBe('1 d 0 h');
    expect(durationText((2 * 24 + 12) * 3_600_000 + 59 * 60_000)).toBe('2 d 12 h');
    expect(durationText(-1)).toBe('0 s');
    expect(durationText(Number.NaN)).toBe('–');
    expect(durationText(Number.POSITIVE_INFINITY)).toBe('–');
    // The live form is formatDuration's, unchanged.
    expect(formatDuration(725_000)).toBe(durationText(725_000, { seconds: true }));
  });

  it('gives a duration as ISO 8601 for <time dateTime>', () => {
    expect(isoDuration(0)).toBe('PT0S');
    expect(isoDuration(45_400)).toBe('PT45S');
    expect(isoDuration(3_600_000)).toBe('PT1H');
    expect(isoDuration(3_725_000)).toBe('PT1H2M5S');
    expect(isoDuration(-5)).toBe('PT0S');
  });

  it('writes a planning time without seconds, in plant time', () => {
    expect(formatPlantTimeMinutes('2026-10-12T19:00:59.000Z')).toBe('Mon 12 Oct, 22:00');
  });
});

/** UX-1d2 (#319): the plant-time input's parsing and formatting (design system 4.8). */
describe('plant-time input helpers', () => {
  it('reads a typed date as a plant day, in the input format and a few others', () => {
    expect(parsePlantDate('12/10/2026')).toBe('2026-10-12');
    expect(parsePlantDate(' 2/3/2026 ')).toBe('2026-03-02');
    expect(parsePlantDate('12.10.2026')).toBe('2026-10-12');
    expect(parsePlantDate('12-10-2026')).toBe('2026-10-12');
    expect(parsePlantDate('2026-10-12')).toBe('2026-10-12');
    // No such day, month first, two-digit years and words are refused.
    expect(parsePlantDate('31/02/2026')).toBeUndefined();
    expect(parsePlantDate('12/13/2026')).toBeUndefined();
    expect(parsePlantDate('00/10/2026')).toBeUndefined();
    expect(parsePlantDate('12/10/26')).toBeUndefined();
    expect(parsePlantDate('today')).toBeUndefined();
    expect(parsePlantDate('')).toBeUndefined();
  });

  it('reads a clock time with or without seconds', () => {
    expect(parsePlantClock('14:05')).toBe(14 * 3600 + 5 * 60);
    expect(parsePlantClock('14:05:09')).toBe(14 * 3600 + 5 * 60 + 9);
    expect(parsePlantClock('7:30')).toBe(7 * 3600 + 30 * 60);
    expect(parsePlantClock('00:00:00')).toBe(0);
    expect(parsePlantClock('23:59:59')).toBe(86_399);
    expect(parsePlantClock('24:00')).toBeUndefined();
    expect(parsePlantClock('12:60')).toBeUndefined();
    expect(parsePlantClock('12:00:60')).toBeUndefined();
    expect(parsePlantClock('1405')).toBeUndefined();
    expect(parsePlantClock('2026-10-12T05:00:00Z')).toBeUndefined();
  });

  it('reads a whole ISO 8601 instant only with its zone', () => {
    expect(parseIsoInstant('2026-10-12T05:00:00Z')).toBe(Date.parse('2026-10-12T05:00:00Z'));
    expect(parseIsoInstant('2026-10-12T05:37:00.123Z')).toBe(
      Date.parse('2026-10-12T05:37:00.123Z'),
    );
    expect(parseIsoInstant('2026-10-12T08:00+03:00')).toBe(Date.parse('2026-10-12T05:00:00Z'));
    expect(parseIsoInstant('2026-10-12T05:00:00')).toBeUndefined();
    expect(parseIsoInstant('2026-10-12')).toBeUndefined();
    expect(parseIsoInstant('2026-13-12T05:00:00Z')).toBeUndefined();
    expect(parseIsoInstant('2026-10-12T25:00:00Z')).toBeUndefined();
    expect(parseIsoInstant('05:00:00')).toBeUndefined();
  });

  it('turns a plant day and clock time into the instant, across plant midnight', () => {
    // Istanbul is UTC+3: plant midnight is 21:00 UTC the day before.
    expect(plantOffsetMs(Date.parse('2026-10-12T05:00:00Z'))).toBe(3 * 3_600_000);
    expect(new Date(plantInstant('2026-10-12', 8 * 3600)).toISOString()).toBe(
      '2026-10-12T05:00:00.000Z',
    );
    expect(new Date(plantInstant('2026-10-13', 0)).toISOString()).toBe('2026-10-12T21:00:00.000Z');
    expect(new Date(plantInstant('2026-10-13', 30 * 60)).toISOString()).toBe(
      '2026-10-12T21:30:00.000Z',
    );
    expect(new Date(plantInstant('2026-10-12', 86_399)).toISOString()).toBe(
      '2026-10-12T20:59:59.000Z',
    );
    // A month's and a year's end.
    expect(new Date(plantInstant('2027-01-01', 3600)).toISOString()).toBe(
      '2026-12-31T22:00:00.000Z',
    );
  });

  it('writes an instant back as the boxes show it, in plant time', () => {
    expect(plantDateText('2026-10-12T21:30:00Z')).toBe('13/10/2026');
    expect(plantDateText('2026-10-12T20:59:59Z')).toBe('12/10/2026');
    expect(plantClockText('2026-10-12T21:30:09Z', true)).toBe('00:30:09');
    expect(plantClockText('2026-10-12T21:30:09Z', false)).toBe('00:30');
    expect(plantDayLabel('2026-10-12')).toBe('Mon 12 Oct');
  });

  it('lists the plant days a range covers', () => {
    // 22:00 to 06:00 plant time: two days.
    expect(plantDaysBetween('2026-10-12T19:00:00Z', '2026-10-13T03:00:00Z')).toEqual([
      '2026-10-12',
      '2026-10-13',
    ]);
    expect(plantDaysBetween('2026-10-12T03:00:00Z', '2026-10-12T11:00:00Z')).toEqual([
      '2026-10-12',
    ]);
    // 20:59:59 UTC is still the 12th in the plant; 21:00 is the 13th.
    expect(plantDaysBetween('2026-10-12T20:59:59Z', '2026-10-12T21:00:00Z')).toEqual([
      '2026-10-12',
      '2026-10-13',
    ]);
    expect(plantDaysBetween('2026-10-13T03:00:00Z', '2026-10-12T03:00:00Z')).toEqual([]);
  });

  it('shows the instant as it is sent, in UTC', () => {
    expect(utcInstantText('2026-10-12T05:00:00.000Z')).toBe('2026-10-12 05:00:00 UTC');
    expect(utcInstantText('2026-10-12T05:37:00.123Z')).toBe('2026-10-12 05:37:00.123 UTC');
  });
});
