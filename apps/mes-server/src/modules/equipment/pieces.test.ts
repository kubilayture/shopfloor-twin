import { resolve } from 'node:path';
import { HOUR, totalsByState } from '@shopfloor/oee-core';
import { loadPlantConfig } from '@shopfloor/plant-config';
import { shiftKeyAt, type ShiftPattern } from '@shopfloor/shift-calendar';
import fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';
import { clamp, cutPieces, monotonic, type Point } from './pieces.ts';

let pattern: ShiftPattern;

beforeAll(async () => {
  const loaded = await loadPlantConfig(resolve(import.meta.dirname, '../../../../../config/plant'));
  if (!loaded.ok) throw new Error('plant config');
  pattern = loaded.config.shifts;
});

/** Monday 2026-10-12 00:00 in Istanbul (UTC+3). */
const MONDAY = Date.UTC(2026, 9, 11, 21);
const local = (hours: number): number => MONDAY + hours * HOUR;
const point = (at: number, state: string, seq: number | null = null, cause = null): Point => ({
  at,
  state,
  cause,
  seq,
});

describe('cutting intervals into hour and shift pieces', () => {
  it('cuts at UTC hours and shift boundaries, keyed like the ground truth', () => {
    // Monday 13:30 to 14:20 local: across the A/B handover, which is also an hour.
    const pieces = cutPieces(
      [point(local(13.5), 'Running', 7), point(local(14) + 20 * 60_000, 'Down', 8)],
      local(14.5),
      pattern,
      true,
    );
    expect(
      pieces.map((p) => [
        (p.from - MONDAY) / 60_000,
        (p.to - MONDAY) / 60_000,
        p.state,
        p.shiftKey,
      ]),
    ).toEqual([
      [810, 840, 'Running', '2026-10-12/A'],
      [840, 860, 'Running', '2026-10-12/B'],
      [860, 870, 'Down', '2026-10-12/B'],
    ]);
    expect(pieces.map((p) => [p.provisional, p.startSeq, p.intervalStart])).toEqual([
      [false, 7, local(13.5)],
      [false, 7, local(13.5)],
      [true, 8, local(14) + 20 * 60_000],
    ]);
  });

  it('drops zero-length intervals; same-millisecond facts belong to the last by seq', () => {
    const at = local(8);
    const pieces = cutPieces(
      [point(at, 'Idle', 1), point(at, 'Running', 2), point(at + 1_000, 'Down', 3)],
      at + 1_000,
      pattern,
      true,
    );
    expect(pieces).toHaveLength(1);
    expect(pieces[0]).toMatchObject({ state: 'Running', startSeq: 2, provisional: false });
    expect(cutPieces([], at, pattern, true)).toEqual([]);
  });

  it('clamps facts that go back in time within an epoch', () => {
    const points = [point(10, 'Idle', 1), point(5, 'Running', 2), point(20, 'Down', 3)];
    expect(monotonic(points)).toBe(false);
    const { points: fixed, clamped } = clamp(points);
    expect(clamped).toBe(true);
    expect(fixed.map((p) => p.at)).toEqual([10, 10, 20]);
    expect(monotonic(fixed)).toBe(true);
    expect(clamp(fixed).clamped).toBe(false);
  });

  it('property: pieces sum to the intervals and never cross an hour or shift boundary', () => {
    const WEEK = 7 * 24 * HOUR;
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: WEEK }),
        fc.array(fc.integer({ min: 0, max: 6 * HOUR }), { minLength: 1, maxLength: 12 }),
        fc.integer({ min: 0, max: 30 * HOUR }),
        (offset, gaps, tail) => {
          let at = MONDAY + offset;
          const points = gaps.map((gap, i) => {
            at += gap;
            return point(at, i % 2 === 0 ? 'Running' : 'Idle', i + 1);
          });
          const end = at + tail;
          const pieces = cutPieces(points, end, pattern, true);
          const first = points[0];
          const span = end - (first?.at ?? end);
          const total = [...totalsByState(pieces).values()].reduce((a, b) => a + b, 0);
          expect(total).toBe(span);
          for (const [i, piece] of pieces.entries()) {
            expect(piece.to).toBeGreaterThan(piece.from);
            if (i > 0) expect(piece.from).toBe(pieces[i - 1]?.to);
            expect(piece.hour).toBe(Math.floor(piece.from / HOUR) * HOUR);
            expect(piece.to).toBeLessThanOrEqual(piece.hour + HOUR);
            expect(shiftKeyAt(pattern, piece.from)).toBe(piece.shiftKey);
            expect(shiftKeyAt(pattern, piece.to - 1)).toBe(piece.shiftKey);
          }
          const open = pieces.filter((p) => p.provisional);
          expect(open.every((p) => p.intervalStart === points.at(-1)?.at)).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });
});
