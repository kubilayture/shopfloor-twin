import { describe, expect, it } from 'vitest';
import { formatClockTime, formatDuration, formatPlantTime, isRangeKey } from './time.ts';

describe('time formatting', () => {
  it('shows plant time in Istanbul', () => {
    expect(formatClockTime('2026-10-15T06:00:00.000Z')).toBe('09:00');
    expect(formatPlantTime('2026-10-15T06:00:05.000Z')).toContain('09:00:05');
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
