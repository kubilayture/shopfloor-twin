import { describe, expect, it } from 'vitest';
import {
  formatClockTime,
  formatDuration,
  formatPlantTime,
  isRangeKey,
  plantTimeText,
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
