import { resolve } from 'node:path';
import { loadPlantConfig } from '@shopfloor/plant-config';
import type { ShiftPattern } from '@shopfloor/shift-calendar';
import { beforeAll, describe, expect, it } from 'vitest';
import { alarmShiftBuckets, noShiftKey } from './buckets.ts';
import {
  deriveOccurrences,
  earliestEffect,
  type Derived,
  type DeviceTransition,
} from './derive.ts';

const PLANT_CONFIG = resolve(import.meta.dirname, '../../../../../config/plant');

const raise = (seq: number, code: string, at: number, severity = 700): DeviceTransition => ({
  seq,
  code,
  transition: 'active',
  severity,
  at,
});
const clear = (seq: number, code: string, at: number): DeviceTransition => ({
  seq,
  code,
  transition: 'cleared',
  severity: 700,
  at,
});
const brief = (list: readonly Derived[]) =>
  list.map((d) => [d.seq, d.code, d.source, d.raisedAt, d.endedAt, d.endReason, d.endSeq]);

describe('deriveOccurrences (#142)', () => {
  it('pairs each clear with the open raise of its code, by seq', () => {
    const facts = [raise(1, 'A', 10), raise(2, 'B', 20), clear(3, 'A', 30), clear(4, 'B', 40)];
    expect(brief(deriveOccurrences(facts, [], null, null))).toEqual([
      [1, 'A', 'fact', 10, 30, 'cleared', 3],
      [2, 'B', 'fact', 20, 40, 'cleared', 4],
    ]);
    // The order facts come in doesn't matter: a clear before its raise waits for it.
    expect(deriveOccurrences([...facts].reverse(), [], null, null)).toEqual(
      deriveOccurrences(facts, [], null, null),
    );
  });

  it('ends an open occurrence at the next raise of its point (a lost clear) and ignores a clear with nothing open', () => {
    const facts = [clear(1, 'A', 5), raise(2, 'A', 10), raise(4, 'A', 40), clear(5, 'A', 50)];
    expect(brief(deriveOccurrences(facts, [], null, null))).toEqual([
      [2, 'A', 'fact', 10, 40, 'superseded', 4],
      [4, 'A', 'fact', 40, 50, 'cleared', 5],
    ]);
  });

  it('takes an anchor whose fact is not stored as a raise or clear, and the fact over it', () => {
    const anchor = { code: 'A', seq: 3, transition: 'active' as const, severity: 300, at: 30 };
    expect(brief(deriveOccurrences([], [anchor], null, null))).toEqual([
      [3, 'A', 'anchor', 30, null, null, null],
    ]);
    expect(brief(deriveOccurrences([raise(3, 'A', 30, 300)], [anchor], null, null))).toEqual([
      [3, 'A', 'fact', 30, null, null, null],
    ]);
    const cleared = { code: 'A', seq: 6, transition: 'cleared' as const, severity: 300, at: 60 };
    expect(brief(deriveOccurrences([raise(3, 'A', 30)], [cleared], null, null))).toEqual([
      [3, 'A', 'fact', 30, 60, 'cleared', 6],
    ]);
  });

  it('closes a raise below a snapshot that shows its code inactive as lost; a device clear wins', () => {
    const snapshot = { asOfSeq: 5, at: 50, active: ['B'] };
    const facts = [raise(1, 'A', 10), raise(2, 'B', 20), raise(3, 'C', 30), clear(4, 'C', 35)];
    expect(brief(deriveOccurrences(facts, [], snapshot, null))).toEqual([
      [1, 'A', 'fact', 10, 50, 'lost', 5],
      [2, 'B', 'fact', 20, null, null, null],
      [3, 'C', 'fact', 30, 35, 'cleared', 4],
    ]);
    // Superseded after the snapshot: the clear was lost before it.
    expect(
      brief(deriveOccurrences([raise(1, 'A', 10), raise(7, 'A', 70)], [], snapshot, null)),
    ).toEqual([
      [1, 'A', 'fact', 10, 50, 'lost', 5],
      [7, 'A', 'fact', 70, null, null, null],
    ]);
    // A raise at or above asOfSeq is newer than the snapshot (an anchor at equal seq is kept).
    const anchor = { code: 'A', seq: 5, transition: 'active' as const, severity: 700, at: 50 };
    expect(brief(deriveOccurrences([], [anchor], snapshot, null))).toEqual([
      [5, 'A', 'anchor', 50, null, null, null],
    ]);
  });

  it('ends what is still open at the close of its epoch', () => {
    const facts = [raise(1, 'A', 10), raise(2, 'B', 20), clear(3, 'B', 25)];
    expect(brief(deriveOccurrences(facts, [], null, { closedAt: 40 }))).toEqual([
      [1, 'A', 'fact', 10, 40, 'epoch-ended', null],
      [2, 'B', 'fact', 20, 25, 'cleared', 3],
    ]);
    // A close without a known time (or before the raise) ends it at its raise.
    expect(brief(deriveOccurrences(facts.slice(0, 1), [], null, { closedAt: null }))).toEqual([
      [1, 'A', 'fact', 10, 10, 'epoch-ended', null],
    ]);
  });
});

describe('earliestEffect (#142)', () => {
  const d = (endedAt: number | null, endReason: Derived['endReason']): Derived => ({
    seq: 1,
    code: 'A',
    severity: 700,
    source: 'fact',
    raisedAt: 100_000,
    endedAt,
    endReason,
    endSeq: null,
  });
  it('is the raise for a new occurrence and the earlier end for a moved end', () => {
    expect(earliestEffect(undefined, d(null, null), 1000)).toBe(100_000);
    expect(earliestEffect(d(null, null), d(150_000, 'cleared'), 1000)).toBe(150_000);
    expect(earliestEffect(d(170_000, 'lost'), d(150_000, 'cleared'), 1000)).toBe(150_000);
    expect(earliestEffect(d(150_000, 'lost'), d(150_000, 'superseded'), 1000)).toBeNull();
  });
  it('is the raise when the occurrence turns fleeting or stops being fleeting', () => {
    expect(earliestEffect(d(null, null), d(100_999, 'cleared'), 1000)).toBe(100_000);
    expect(earliestEffect(d(100_500, 'lost'), d(100_500, 'cleared'), 1000)).toBe(100_000);
  });
});

describe('alarm shift buckets (ADR-0024 keys)', () => {
  let pattern: ShiftPattern;
  beforeAll(async () => {
    const loaded = await loadPlantConfig(PLANT_CONFIG);
    if (!loaded.ok) throw new Error('plant config');
    pattern = loaded.config.shifts;
  });
  it('keys a no-shift stretch by its start by the calendar, clipped to the range', () => {
    const saturday = Date.parse('2026-10-17T03:00:00Z');
    const sunday = Date.parse('2026-10-18T09:00:00Z');
    expect(noShiftKey(pattern, sunday)).toBe('no-shift/2026-10-17T03:00:00.000Z');
    expect(alarmShiftBuckets(pattern, sunday, sunday + 3_600_000)).toEqual([
      { key: 'no-shift/2026-10-17T03:00:00.000Z', from: sunday, to: sunday + 3_600_000 },
    ]);
    const friday = alarmShiftBuckets(pattern, saturday - 3_600_000, saturday + 3_600_000);
    expect(friday.map((b) => b.key)).toEqual(['2026-10-16/C', 'no-shift/2026-10-17T03:00:00.000Z']);
  });
});
