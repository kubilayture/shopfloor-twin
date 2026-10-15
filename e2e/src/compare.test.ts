import { describe, expect, it } from 'vitest';
import {
  HOUR,
  differences,
  formatDifferences,
  mesTotals,
  percentile,
  pieceViolations,
} from './compare.ts';

const T = Date.UTC(2026, 9, 12, 3);

describe('reconciliation comparisons (#100)', () => {
  it('fills the MES totals into the ground truth shape and sets other epochs apart', () => {
    const totals = mesTotals(
      [
        { equipment: 'cnc-01', epoch: 7, state: 'Running', ms: 1_000, provisionalMs: 0 },
        { equipment: 'cnc-01', epoch: 7, state: 'Idle', ms: 500, provisionalMs: 500 },
        { equipment: 'cnc-01', epoch: 6, state: 'Idle', ms: 9, provisionalMs: 0 },
        { equipment: 'xyz', epoch: 7, state: 'Idle', ms: 9, provisionalMs: 0 },
      ],
      7,
      ['cnc-01', 'wsh-01'],
    );
    expect(totals.byMachine['cnc-01']).toMatchObject({ Running: 1_000, Idle: 500, Off: 0 });
    expect(Object.values(totals.byMachine['wsh-01'] ?? {}).every((ms) => ms === 0)).toBe(true);
    expect(totals.provisionalMs).toEqual({ 'cnc-01': 500, 'wsh-01': 0 });
    expect(totals.unexpected).toHaveLength(2);
  });

  it('lists and formats every differing state, and nothing when equal', () => {
    const truth = { 'cnc-01': { Running: 1_000, Idle: 0 } };
    expect(differences(truth, { 'cnc-01': { Running: 1_000 } })).toEqual([]);
    const diffs = differences(truth, { 'cnc-01': { Running: 999, Down: 1 } });
    expect(diffs).toEqual([
      { machine: 'cnc-01', state: 'Running', truth: 1_000, mes: 999 },
      { machine: 'cnc-01', state: 'Down', truth: 0, mes: 1 },
    ]);
    expect(formatDifferences(diffs).split('\n')[1]).toMatch(/^cnc-01 +Running +1000 +999 +-1$/);
  });

  it('finds pieces that cross an hour or a shift, or carry the wrong keys', () => {
    const segments = (from: number, to: number) =>
      [
        { from: T, to: T + 8 * HOUR, key: '2026-10-12/A' },
        { from: T + 8 * HOUR, to: T + 16 * HOUR, key: '2026-10-12/B' },
      ].filter((s) => s.from < to && from < s.to);
    const piece = (start: number, end: number, shiftKey = '2026-10-12/A', hour = start) => ({
      equipment: 'cnc-01',
      start,
      end,
      hour: Math.floor(hour / HOUR) * HOUR,
      shiftKey,
    });
    expect(
      pieceViolations(
        [piece(T, T + HOUR), piece(T + 8 * HOUR, T + 8 * HOUR + 5, '2026-10-12/B')],
        segments,
      ),
    ).toEqual([]);
    const problems = pieceViolations(
      [
        piece(T, T + HOUR + 1),
        piece(T + 7 * HOUR, T + 8 * HOUR, '2026-10-12/B'),
        piece(T + 2 * HOUR, T + 2 * HOUR + 1, '2026-10-12/A', T),
        piece(T, T),
      ],
      segments,
    );
    expect(problems).toHaveLength(4);
    expect(problems.join('\n')).toMatch(/crosses the UTC hour/);
    expect(problems.join('\n')).toMatch(/shift buckets 2026-10-12\/A$/m);
  });

  it('takes nearest-rank percentiles', () => {
    expect(percentile([5, 1, 4, 2, 3], 50)).toBe(3);
    expect(percentile([5, 1, 4, 2, 3], 100)).toBe(5);
    expect(percentile([7], 95)).toBe(7);
  });
});
