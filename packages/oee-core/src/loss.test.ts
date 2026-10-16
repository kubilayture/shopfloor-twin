import { describe, expect, it } from 'vitest';
import { availabilityLoss } from './index.ts';

describe('availability loss of an interval (ADR-0021, #119)', () => {
  it('follows the loss table: own, external, or none', () => {
    const of = (state: string, wholeMs = 60_000) => availabilityLoss(state, wholeMs, 120_000);
    expect(['Down', 'Setup', 'Idle'].map((s) => of(s))).toEqual(['own', 'own', 'own']);
    expect(['Starved', 'Blocked'].map((s) => of(s))).toEqual(['external', 'external']);
    expect(['Running', 'PlannedStop', 'Maintenance', 'Off'].map((s) => of(s))).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    // Down is never a micro-stop, however short.
    expect(of('Down', 1)).toBe('own');
  });

  it('counts a Stopped interval from the threshold on, over its whole length', () => {
    expect(availabilityLoss('Stopped', 119_999, 120_000)).toBeUndefined();
    expect(availabilityLoss('Stopped', 120_000, 120_000)).toBe('own');
  });
});
